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
          "reason": "missing_required | unknown_value | out_of_range | type_mismatch | pattern_mismatch | unknown_table | unknown_field | target_absent | target_in_use | duplicate | newtron_owned_table_forbidden",
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
  in a specific input, not a system condition).
  `newtron_owned_table_forbidden` is the substrate-grounded refusal of
  a direct CONFIG_DB write addressed to a table newtron owns: the
  table IS recognized (so `unknown_table` would teach the wrong
  semantics), but direct writes are architecturally forbidden per
  `DESIGN_PRINCIPLES_NEWTRON.md` §1 — the operator must use intent
  submission instead. `locator.substrate_field.table` names the
  refused table; the rejection's `message` points the operator at
  `/api/intents/preview`.
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
| `node_unknown` | `node` path parameter not in the spec | `{ node, network }` |
| `service_unknown` | `service` path parameter not in the spec | `{ service }` |
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
  `inspect_operation`, `open_inbox_card`, `file_gap_followup`,
  `retry_after_expiry`, etc.); `endpoint` points to where the verb is
  invoked. The hint is not prescriptive but it is concrete — the
  operator does not need to read other docs to know what to do next
  (operator-philosophy invariant #7 plus invariant #9).
- **`provenance_url`** points to the relevant Provenance endpoint
  when applicable: for `intent_resolved`, the reverse operation; for
  `operation_evicted`, `null` (the operation is gone, so there is
  nothing to link); for `batch_state_invalid`, the batch URL itself.
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
  `null` in v0. Reserved for the call-site provenance that
  [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)
  will populate when it lands: `{ call_site: "<file:line>", function: "<go-method-name>" }`,
  exposing the newtron Go method that emitted this substrate
  operation. newtron#12 is operator-filed and currently OPEN; the
  contract reserves the field shape and key so the streaming consumer
  does not need a contract update when call-site provenance ships
  (additive evolution per `DESIGN_PRINCIPLES_NEWTRON` §46's fourth
  rule). When newtron#12 ships, a follow-up Contract PR populates
  the `source` field's contents; consumers receive `null` until then
  and MUST tolerate it.

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
The payload IS the same JSON object the JSON-variant returns; it is
not a strict superset, not a subset. This avoids forking the
terminal shape between variants — consumers using SSE for live
events and JSON for batch snapshots see the same per-target /
per-write / aggregate shape.

```
event: apply_complete
data: { "operation_id": "<opaque>", "per_target": [ { "node": "switch1", ..., "per_write": [ /* PerWrite[] */ ], ... } ], "aggregate": { ... }, "per_node_atomicity": [ /* same shape as JSON variant */ ] }
```

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
newtron-server exposing per-substrate-operation results — either as
an SSE stream of its own, or as a callback API, or as a per-write
results array in the existing endpoints' responses. newtron's
current `/intent/reconcile`, `/execute`, and
`/interface/{name}/apply-service` endpoints return on completion
with `WriteResult` (`{change_count, applied, verified, saved,
verification}`) — an aggregate, not per-substrate-operation entries.

This is a Gap-Handling Protocol gap. The newtron-side issue
tracking it is filed at
[newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
(per-substrate-operation surfacing on newtron's write endpoints).
This contract section names the operator-visible shape the gap
needs to fill; the newtron issue surveys newtron's current routes
and types to scope the work.

Until newtron#19 ships, `per_write` arrays in newtcon's responses
are empty (`per_write: []`), `manual_equivalent.newtron_http.status`
on the affected endpoints is `"pending_newtron_gap"` with
`gap_issue` pointing at newtron#19, and the SSE variant emits
exactly one `apply_complete` event (no `substrate_op` events)
because newtcon-server has nothing to stream. The operator-facing
contract shape is stable now so frontend work can proceed against
it; the operator-visible behavior fills in as newtron#19 lands.

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
  }
}
```

The `newtron.reachable` field is the result of a lightweight upstream health
probe; `newtron.version` is whatever newtron-server reports on its own health
endpoint. If newtron-server is unreachable, `reachable` is `false` and the
endpoint still returns 200 — newtcon-server itself is alive.

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
      "validate": { "ok": true, "errors": [] },
      "changeset": {
        "writes": [ /* CONFIG_DB key+fields */ ],
        "deletes": [ /* CONFIG_DB keys */ ]
      },
      "reference_impact": {
        "created": ["ROUTE_MAP_ab12cd34"],
        "incremented": [],
        "garbage_collected": []
      }
    }
  ],
  "aggregate": {
    "all_valid": true,
    "node_count": 2,
    "total_writes": 14,
    "total_deletes": 0
  }
}
```

Validation failures in any target produce a 200 with `validate.ok = false` for
the failing target(s) and `aggregate.all_valid = false`. The preview is still
returned for the targets that did validate.

A drift-guard refusal on any target → 409 with `kind: "drift_refusal"`
and `details` per the typed schema in §Error Schema (`per_target[]`
listing the offending Nodes and their `drift_entries[]`, plus a
resolution hint linking to the existing Inbox card). The preview is
not committed.

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
        "state": "in_progress"
      },
      "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ]
    }
  ],
  "aggregate": {
    "all_applied": true,
    "verify_pending": 1,
    "total_writes_landed": 14,
    "total_writes_rejected": 0,
    "total_daemon_waits": 2,
    "total_verify_reads_failed": 0
  }
}
```

`pipeline` is the 4-stage trace defined by
`unified-pipeline-architecture.md` §2; `verify` is the Device I/O
assertion defined by §7 and `DESIGN_PRINCIPLES_NEWTRON` §14. Both shapes
match `GET /api/operations/{operation_id}`; this response is the snapshot
at apply-return time, and the operations endpoint is the polling
location for post-deliver verify completion.

The `verify.state` may transition from `in_progress` to `complete` or
`failed` after the response returns; consumers poll
[`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id) for
the terminal verify state.

**`per_target[*].per_write[]`** is the per-substrate-operation
sequence newtron executed for this target, ordered by `seq`. Each
entry is a `PerWrite` per §Streaming substrate-operation events
(`{seq, operation_id, target, kind, substrate, result, cli_command,
device_response, at, rationale_ref, source}`). Empty `per_write[]`
indicates either:
(a) the target had no Device I/O Operations (e.g., the target was a
dry-run that newtron-server resolved to a no-op ChangeSet — which
the validate stage should have caught at preview time; receiving an
empty `per_write[]` on a target whose `applied == true` is a signal
to file an ops ticket); OR
(b) newtron-server has not yet shipped the per-substrate-operation
exposure tracked by [newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
— pending that gap, `per_write[]` is empty on every target and the
operator-visible behavior degrades to the historical aggregate.
Consumers MUST treat `per_write: []` as honest (newtron has nothing
to report), not as missing data; the
`manual_equivalent.newtron_http.status` block on this endpoint moves
to `"pending_newtron_gap"` until the gap closes.

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
      "dismissed": null
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
    }
  }
}
```

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
  ]
}
```

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
  "changeset": {
    "writes": [ /* CONFIG_DB key+fields */ ],
    "deletes": [ /* CONFIG_DB keys */ ],
    "intent_records": [ /* NEWTRON_INTENT records prepended */ ]
  },
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
  "validate": { "ok": true, "errors": [] },
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
  `reconcile_mode`, and `drift_resolved_preview` are omitted; `consequence`
  is present instead with the same shape as the dismiss preview's
  `consequence`.
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
- `manual_equivalent.newtron_http` is an object with one of four
  shapes; `status` is the discriminator and is bounded by the enum
  `available | pending_newtron_gap | partial_match | not_applicable`:
  (a) `{ "status": "available", "method", "path", "query"?, "body"? }`
  — an endpoint that exists in `newtron/docs/newtron/api.md` today
  and answers the same question with the same substrate;
  (b) `{ "status": "pending_newtron_gap", "gap_issue": "<URL>",
  "expected_shape": { … } }` — no newtron HTTP shape exists today;
  tracked under the Gap-Handling Protocol (`CLAUDE.md`
  §Gap-Handling Protocol);
  (c) `{ "status": "partial_match", "method", "path", "query"?,
  "body"?, "note": "<rationale>" }` — an endpoint exists that
  answers a related but not identical question; the `note` explains
  the gap honestly (used, e.g., on the Provenance verify endpoint,
  where newtron's `verify-committed` re-verifies the LAST committed
  ChangeSet rather than a specified historical operation);
  (d) `{ "status": "not_applicable", "rationale": "<text>" }` — no
  newtron HTTP shape applies, by design, because the substrate is
  not addressable in newtron's model (used, e.g., on the
  Provenance ChangeSet endpoint, where ChangeSets are
  per-invocation artifacts in newtron and the addressable retention
  is a newtcon-server concern).
  The shape MUST be one of these four — silently fabricating an
  endpoint URL is forbidden. `newtron_cli` always points to the
  equivalent CLI invocation when one exists; it is `null` when no
  CLI equivalent applies (matching `not_applicable`).
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
`DESIGN_PRINCIPLES_NEWTRON` §13) → 200 with `validate.ok == false` and
`validate.errors[]` populated; the preview is returned but
`produces_changeset` does not imply executable. When the validation
failure is severe enough that newtcon-server refuses to return a
preview at all (rather than returning it with `validate.ok == false`),
the response is 400 with `kind: "validation_failure"` per the typed
schema in §Error Schema, with `validation_stage: "substrate_schema"`
or `"substrate_precondition"` per `DESIGN_PRINCIPLES_NEWTRON` §13's
two-refusals split.

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
    "started_at": "2026-05-25T14:06:02Z"
  },
  "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ],
  "substrate_summary": {
    "writes_landed": 14,
    "writes_rejected": 0,
    "daemon_waits": 2,
    "verify_reads_failed": 0
  },
  "card_state_after": "resolved | persists | armed_for_recheck"
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
`per_write[]` is honest: either the verb produced no ChangeSet
(`acknowledge`, `clear_zombie`, `recheck` — in which case
`substrate_summary` is also all-zero) or the newtron-side gap
[newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
has not yet shipped per-substrate-operation surfacing.

`substrate_summary.*` are substrate-operation counts derivable from
`per_write[]`. REQUIRED on every response (zeroed for no-ChangeSet
verbs) so the operator's first view shows substrate cadence (14
writes, 2 daemon waits, 0 verify failures), not just the abstract
`executed: true`. Operator-philosophy invariant #1 ("no black
boxes") applies to the action's terminal summary as much as to its
per-write detail.

For verbs that produce no ChangeSet (`acknowledge`, `clear_zombie`,
`recheck`), `operation_id`, `operation_url`, `pipeline`, and `verify` are
omitted; `per_write: []` and `substrate_summary` zeroed.

**Response 200 (SSE variant — `Accept: text/event-stream`):** stream
per §Streaming substrate-operation events. The terminal
`apply_complete` event's data payload is byte-for-byte the same JSON
object documented above for the JSON variant.

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

### `GET /api/operations/{operation_id}`

Return the full trace for an in-flight or recently completed operation.
Idempotent; safe to poll. No newtron-side state is mutated.

**Operations endpoint retention semantics are NOT yet pinned down**
(source-of-truth, retention window, eviction policy). Tracked in
[newtcon#18](https://github.com/aldrin-isaac/newtcon/issues/18). This
contract specifies a minimum behavior (operations retained at least
30 minutes after terminal-state) sufficient to unblock implementer
work; the full retention contract lands in a follow-up PR.

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
          "actual": ""
        }
      ]
    }
  },
  "terminal": {
    "reached": true,
    "outcome": "success | failure | partial",
    "at": "2026-05-25T14:06:03Z",
    "summary": "applied; verify passed"
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
  §15 Write Result Types): `passed`, `failed`, `errors[]`. `errors[]`
  is absent when all entries passed. Present only when `verify.state ==
  "complete"` or `verify.state == "failed"`. Per
  `DESIGN_PRINCIPLES_NEWTRON` §14, verify is an assertion against the
  ChangeSet — newtron knows what it wrote — so the shape is
  `expected/actual` per field, never a "verification status" enum that
  would conflate assertion with cross-device observation.
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

**Errors:**
- Unknown or expired `operation_id` → 404 with
  `kind: "precondition_failure"` per the typed schema in §Error
  Schema, with `condition: "operation_unknown_or_expired"`.
- newtron-server unreachable while the operation is still in-flight →
  503 with `kind: "newtron_unavailable"` per the typed schema in §Error
  Schema. `details.last_known.kind` is `"operation_pipeline"` and
  `details.last_known.payload` carries the last-observed pipeline
  snapshot; `details.affected_nodes[]` lists the Node the operation
  targets.

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
        "validate": { "ok": true, "errors": [] },
        "changeset": {
          "writes": [ /* CONFIG_DB key+fields */ ],
          "deletes": [ /* CONFIG_DB keys */ ]
        },
        "reference_impact": {
          "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
          "incremented": [],
          "decremented": [],
          "garbage_collected": []
        }
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
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/4",
      "expected_shape": {
        "method": "POST",
        "path": "/network/{n}/node/{d}/projection/diff",
        "body": { "intents": [ /* staged intents */ ] }
      }
    }
  }
}
```

**Why `pending_newtron_gap`:** newtron's batch-execute endpoint with
`execute: false` returns a `WriteResult` (preview text + change count)
and not a typed projection-before/after pair. The raw CONFIG_DB read
endpoints return device-actual entries, not the typed
projection-from-intent-replay; the composite endpoint returns counts
and an opaque handle, not the typed composite contents. There is no
composition of existing newtron HTTP endpoints that yields the typed
per-table-per-key-per-field before/after projection diff this surface
needs. The gap was filed by the newtcon Architect at the time this
contract was written, per `CLAUDE.md` §Gap-Handling Protocol; see
[newtron#4](https://github.com/aldrin-isaac/newtron/issues/4) for the
proposed HTTP shape (which matches the `expected_shape` block above).
The implementer slice for `/diff` is blocked until newtron#4 lands.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure` per the typed schema
  in §Error Schema.
- newtron unreachable → 503 `newtron_unavailable` per the typed schema
  in §Error Schema. `details.last_known.kind` is `"projection_diff"`
  and `details.last_known.payload` carries the most recent successful
  diff if any (`kind: "none"` if none has been computed).

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
      "validate": { "ok": true, "errors": [] },
      "changeset": {
        "writes": [ /* CONFIG_DB key+fields */ ],
        "deletes": [ /* CONFIG_DB keys */ ]
      },
      "reference_impact": {
        "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
        "incremented": [],
        "decremented": [],
        "garbage_collected": []
      },
      "intent_record_preview": {
        "key": "service|transit|Ethernet0",
        "fields": { /* NEWTRON_INTENT record fields that would be written */ }
      }
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
    "total_deletes": 0
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
false` for the failing entries. The preview is still returned for the
targets that validated. The operator commits a partial-validity
preview at their own risk: commit will reject if any per-target is
invalid (see commit response).

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
  }
}
```

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
        "started_at": "2026-05-25T14:15:02Z"
      },
      "intent_record": {
        "key": "service|transit|Ethernet0",
        "fields": { /* NEWTRON_INTENT record actually written */ }
      },
      "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ],
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
    "total_verify_reads_failed": 0
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
    for this intent's per-Node bundle; verify may still be in
    progress (post-deliver Device I/O per
    `unified-pipeline-architecture.md` §7).
  - `failed` — newtron's batch-execute returned a failure on this
    intent's per-Node bundle. The whole per-Node bundle is failed
    (per-Node atomicity); the `failure` object carries the
    substrate-level error from newtron.
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
  `per_write[]` is honest: either the target was `not_attempted`
  (no Device I/O happened) or the newtron-side gap
  [newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
  has not yet shipped per-substrate-operation surfacing. On
  `status == "failed"`, `per_write[]` carries the substrate
  operations that landed before the per-Node TxPipeline was
  rejected (typically zero — schema validation per
  `DESIGN_PRINCIPLES_NEWTRON` §13 refuses the bundle before the
  `EXEC`); when the failure is post-EXEC (daemon-rejection during
  settle, verify-failure on a re-read), `per_write[]` carries every
  applied substrate operation plus the rejected entry.
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
  `unified-pipeline-architecture.md` §2).
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
      "validate": { "ok": true, "errors": [] },
      "changeset": {
        "writes": [ /* CONFIG_DB key+fields */ ],
        "deletes": [ /* CONFIG_DB keys */ ]
      },
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
      ]
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

## Endpoints — Manual-Mode Parity

The Manual-mode parity surface is **the operator's first-class lever
for hand-authoring intents and reading the manual decomposition of any
automated action.** It is the contract realization of
operator-philosophy invariant #2 ("Manual-mode parity"), declared in
[`docs/operator-philosophy.md`](docs/operator-philosophy.md):

> Anything the automation can do, the operator can do by hand through
> the same surface. Automation is an accelerator on top of manual
> control, not a replacement for it. The same UI elements that drive
> automated actions can drive manual ones; the operator chooses which
> lever to pull. There is no "advanced mode" hidden behind a flag —
> there is one mode, with automation as an opt-in convenience.

Without this surface, newtcon is automation-only — which the
philosophy explicitly rejects as "autopilot whose pilots cannot fly the
plane when the autopilot fails" (the litmus test in
`docs/operator-philosophy.md`). The surface is therefore load-bearing
on the whole capability-amplification thesis of newtcon, not optional.

### How this surface differs from per-verb `manual_equivalent`

Every state-changing endpoint in this contract already carries a
`manual_equivalent.newtron_http` block — the `curl` invocation that
reproduces THAT endpoint's effect by hand. That per-verb block is the
"this is the manual analogue of THIS automated action" annotation.

The Manual-mode parity SURFACE is one level up: it is the operator's
first-class action surface for hand-authoring an intent **without first
choosing an automated verb to read off of**. The operator opens this
surface to write an intent record directly, not to inspect what a
service-spec apply would do manually.

Both exist because both are needed. The per-verb annotation teaches the
operator "if I had clicked Apply, here is the `curl` I could run
instead." The surface teaches the operator "if I want to do something
the automation does not propose at all, here is the hand-authoring
ground." Operator-philosophy invariant #2 demands the latter; the
former is necessary but not sufficient.

### Two paths: typed-intent submission and per-CONFIG_DB-key writes

The substrate has two write paths, and newtron's design draws a hard
line between them:

- **Typed intent submission.** The operator constructs a NEWTRON_INTENT
  record (operation, resource key, user params, parents) and submits it
  to be replayed through the pipeline (`Intent → Replay → Render →
  Deliver`). Per `DESIGN_PRINCIPLES_NEWTRON.md` §1, §20, this is the
  canonical write path; every newtron-owned CONFIG_DB entry comes from
  an intent replay. The Manual-mode parity surface exposes typed intent
  submission as `POST /api/intents/preview` + `POST /api/intents`.
- **Per-CONFIG_DB-key write (non-newtron-owned tables only).** The
  operator addresses a single CONFIG_DB table+key+field-set directly,
  with no NEWTRON_INTENT record produced. Per
  `DESIGN_PRINCIPLES_NEWTRON.md` §1, this path is architecturally
  forbidden for newtron-owned tables (it would create state newtron
  cannot reconstruct, drift-detect, or symmetrically reverse). It is
  surfaced for tables newtron does NOT own — third-party-managed
  tables, vendor extensions, operator-side custom tables — where
  newtron's intent abstraction does not apply by construction. The
  surface exposes these as
  `POST /api/configdb/{network}/{node}/{table}/{key}/write/preview` +
  `POST /api/configdb/{network}/{node}/{table}/{key}/write`, both
  `pending_newtron_gap` against newtron's HTTP API today (see
  [newtron#10](https://github.com/aldrin-isaac/newtron/issues/10)).

Both paths share the same preview/apply pairing, the same per-target
result shape, the same per-Node atomicity classification, the same
4-stage pipeline trace + Verify-as-Device-I/O assertion, the same Error
schema, and the same companion `intent_url` / `changeset_url` /
`operation_url` navigation links as Composer, Inbox, and Workbench.
The operator practices identical mechanics across surfaces — that
identity is what makes Manual-mode parity a parity surface, not a
parallel parallel-universe surface.

### Third path: manual decomposition browser

For every automated action the operator might invoke through Composer,
Inbox, or Workbench, the Manual-mode parity surface also exposes
`GET /api/manual_decomposition` — the step-by-step decomposition of
that action into the sequence of intent submissions (or
per-CONFIG_DB-key writes) the operator would execute by hand to
reproduce the same effect. The operator opens this endpoint not to
DO the manual sequence, but to REHEARSE it — to learn how the
automation decomposes into manual steps, so that when the automation
fails the operator can step through the decomposition themselves.

This is the operationalization of "the operator can do it by hand":
not just "there exists a manual path" but "here is the exact manual
path, step by step, that this automated action would have taken."
Operator-philosophy invariant #2's "anything the automation can do,
the operator can do by hand" is binding only if the operator can SEE
the decomposition; the surface makes the decomposition first-class.

### Identifiers

- `intent_id` — opaque, server-assigned at intent-submission preview
  time, stable through commit. After successful apply, the same
  `intent_id` resolves via [`GET /api/intents/{intent_id}`](#get-apiintentsintent_id)
  on the Provenance surface — manual intent submissions are
  indistinguishable from any other intent on the substrate.
- `preview_id` — opaque, returned by every `*/preview` endpoint, valid
  for 5 minutes. Same shape and TTL as elsewhere in the contract.
- `operation_id` — opaque, server-assigned on apply. Resolves via
  [`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id)
  on the Operations surface.

### `POST /api/intents/preview`

Preview a raw, operator-authored intent submission. **No newtron-side
mutation.** Returns the ChangeSet the intent would produce, the
reference impact, the per-Node atomicity, the pipeline-stage trace,
and the projection rebuild that would result. Mandatory before
`POST /api/intents` per `CLAUDE.md` §Preview Before Commit, Always.

The request is shaped to mirror newtron's NEWTRON_INTENT record
(`../newtron/docs/newtron/intents.md` §1 "Intent Record Structure"):
the operator addresses the intent by the same fields newtron uses
internally. There is no operator-facing summarization of the
substrate; the operator authors the intent in the substrate's own
vocabulary, per operator-philosophy invariant #3 ("the substrate is
the teaching surface") and invariant #1 ("no black boxes").

**Request:**
```json
{
  "intents": [
    {
      "operation": "apply-service",
      "network": "default",
      "node": "switch1",
      "resource_key": "interface|Ethernet0",
      "name": "transit",
      "state": "actuated",
      "user_params": {
        "service": "transit",
        "ip_address": "10.1.0.0/31",
        "peer_as": 65002
      },
      "parents": ["vrf|Vrf_TRANSIT", "service|transit"],
      "resolved_params_strategy": "let_newtron_resolve",
      "resolved_params": null
    }
  ],
  "atomicity_intent": "per_node | per_intent"
}
```

Field rules:

- **`intents[]`** — one or more intent submissions. A submission of
  multiple intents on the same Node bundles them into one per-Node
  call. Submissions across multiple Nodes inherit Workbench's
  per-Node atomicity model (per-Node atomic, cross-Node sequential).
  Empty `intents[]` → 400 `validation_failure`.
- **`operation`** is the Op constant from
  `../newtron/docs/newtron/intents.md` §1.1 (e.g., `"apply-service"`,
  `"create-vlan"`). The newtron vocabulary; not paraphrased. Bounded
  by the active newtron version's intent catalog; unknown values →
  400 `validation_failure` with `details.rejections[*].reason ==
  "unknown_value"` and `details.rejections[*].allowed` carrying the
  catalog.
- **`resource_key`** is the DAG-key the intent addresses
  (e.g., `interface|Ethernet0`). Validated against the operation per
  `../newtron/docs/newtron/intents.md` §7 (e.g., `apply-service`
  requires `interface|*`). Mismatch → 400 `validation_failure`.
- **`name`** is the spec reference per `intents.md` §1.1. Bound by
  the operation; for verbs that have no `name` (e.g., `create-vlan`),
  this field is the empty string or absent.
- **`state`** defaults to `actuated`. `unrealized` is admitted for
  the operator-declared-but-not-yet-applied case
  (`intents.md` §1.2). `in-flight` is forbidden in submissions — that
  state is owned by newtron's `writeIntent` internally.
- **`user_params`** is the dual-purpose intent's user-params half per
  `DESIGN_PRINCIPLES_NEWTRON.md` §22. REQUIRED on every submission.
  Per §22, snapshot reads user params for reconstruction; the
  operator hand-authors the same shape automation would synthesize.
- **`parents`** is the declared parent set, validated against
  `intents.md` §2 invariant I4 (parents must exist) at preview-render
  time. Missing parents → 400 `validation_failure` with
  `details.rejections[*].reason == "target_absent"` and
  `details.rejections[*].locator.substrate_field` naming the missing
  parent's resource key.
- **`resolved_params_strategy`** is the discriminator for how the
  dual-purpose intent's resolved-params half is computed:
  - `let_newtron_resolve` (default) — newtron resolves specs and
    computes resolved params, identical to the typed-verb path. The
    operator stops at user params.
  - `use_supplied` — operator provides `resolved_params` explicitly.
    Used when the operator is intentionally overriding spec
    resolution. The resolved params land in the intent record
    verbatim, per §22.
- **`resolved_params`** is REQUIRED when
  `resolved_params_strategy == "use_supplied"`, FORBIDDEN otherwise.
  An empty object when supplied is rejected with 400
  `validation_failure` — the operator must name the override
  substrate, not implicitly elide it.
- **`atomicity_intent`** is the operator's explicit choice between
  `per_node` (default — bundle per-Node intents into one
  TxPipeline-atomic call, matching Workbench's model) and
  `per_intent` (each intent is a separate per-Node call; intents on
  the same Node still serialize per the per-device actor in
  `DESIGN_PRINCIPLES_NEWTRON.md` §31, but they do not share atomicity).
  Operator-philosophy invariant #8 ("operator-defined automation, not
  tool-imposed automation") binds: newtcon does not impose the safer
  default silently; the operator chooses.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "rendered_at": "2026-05-26T14:08:00Z",
  "per_intent": [
    {
      "intent_index": 0,
      "operation": "apply-service",
      "network": "default",
      "node": "switch1",
      "resource_key": "interface|Ethernet0",
      "intent_id": "<opaque>",
      "intent_url": null,
      "validate": { "ok": true, "errors": [] },
      "changeset": {
        "writes": [ /* CONFIG_DB key+fields, including the NEWTRON_INTENT record */ ],
        "deletes": [ /* CONFIG_DB keys */ ]
      },
      "intent_record_preview": {
        "key": "interface|Ethernet0",
        "fields": { /* NEWTRON_INTENT record that would be written, including user + resolved params */ }
      },
      "resolved_params_origin": "newtron_resolved | operator_supplied",
      "reference_impact": {
        "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
        "incremented": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"],
        "decremented": [],
        "garbage_collected": []
      },
      "dag_context_preview": {
        "parents_resolved": [
          {
            "resource_key": "vrf|Vrf_TRANSIT",
            "intent_id": "<opaque>",
            "intent_url": "/api/intents/<opaque>",
            "exists_in_intent_db": true
          },
          {
            "resource_key": "service|transit",
            "intent_id": "<opaque>",
            "intent_url": "/api/intents/<opaque>",
            "exists_in_intent_db": true
          }
        ],
        "children_after_apply": []
      }
    }
  ],
  "per_node_calls": [
    {
      "node": "switch1",
      "intent_count": 1,
      "atomicity": "atomic_via_txpipeline",
      "atomicity_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
      },
      "manual_equivalent": {
        "newtron_cli": "newtron switch1 intent submit --file intent.json",
        "newtron_http": {
          "status": "pending_newtron_gap",
          "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/9",
          "expected_shape": {
            "method": "POST",
            "path": "/network/default/node/switch1/intent",
            "query": { "dry_run": "false" },
            "body": {
              "operation": "apply-service",
              "resource_key": "interface|Ethernet0",
              "name": "transit",
              "state": "actuated",
              "user_params": { "service": "transit", "ip_address": "10.1.0.0/31", "peer_as": 65002 },
              "parents": ["vrf|Vrf_TRANSIT", "service|transit"],
              "resolved_params_strategy": "let_newtron_resolve"
            }
          }
        }
      }
    }
  ],
  "execution_order": [
    { "step": 1, "node": "switch1", "rationale": "single Node" }
  ],
  "cross_node_atomicity": null,
  "aggregate": {
    "all_valid": true,
    "intent_count": 1,
    "node_count": 1,
    "total_writes": 14,
    "total_deletes": 0
  },
  "aggregate_reference_impact": {
    "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
    "incremented": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"],
    "decremented": [],
    "garbage_collected": []
  },
  "disruption": {
    "config_reload_nodes": [],
    "bgp_restart_nodes": [],
    "estimated_data_plane_impact": "control-plane-only",
    "rationale": [
      { "input": "operations", "value": ["apply-service"], "contribution": "control-plane-only (BGP neighbor add, no reload)" },
      { "input": "bgp_restart_inferred", "value": false, "contribution": "none" }
    ]
  },
  "preflight": {
    "all_nodes_reachable": true,
    "unreachable_nodes": [],
    "drift_guard_clean": true,
    "drift_blocked_nodes": []
  }
}
```

Field rules:

- **`per_intent[*]`** is one entry per submitted intent. The shape
  is symmetric with Workbench's `dry_run` `per_target[]` so the
  frontend reuses its rendering logic — `validate`, `changeset`,
  `reference_impact` are the same fields with the same semantics.
- **`per_intent[*].intent_record_preview`** is the NEWTRON_INTENT
  record that would be written, with both user and resolved params
  visible. Per operator-philosophy invariant #1 ("no black boxes"),
  the operator MUST see the full intent record at preview time —
  including whatever newtron's spec resolver computed for resolved
  params when `resolved_params_strategy == "let_newtron_resolve"`.
  The operator who submits a raw intent should never be surprised by
  what landed.
- **`per_intent[*].resolved_params_origin`** discriminates
  `newtron_resolved` (newtron's spec resolution computed the
  resolved-params half) from `operator_supplied` (the operator
  supplied them verbatim). The discriminator is load-bearing at
  inspection time: an operator looking at the intent in the
  Provenance surface a year later must be able to tell whether the
  resolved params came from spec resolution at apply time (subject
  to spec drift) or from the operator's explicit override (subject
  to operator authorship).
- **`per_intent[*].dag_context_preview.parents_resolved[*].exists_in_intent_db`**
  carries the I4 check result. `false` here corresponds to a 400
  refusal at submission time (`writeIntent` would fail I4); the
  preview surfaces the failure ahead of submission so the operator
  can either author the missing parent first or fix the resource
  key.
- **`per_node_calls[*]`** uses the same shape as Workbench's
  `/commit/preview` `per_node_calls[*]`: per-Node atomicity
  classification, atomicity rationale_ref, and the
  `manual_equivalent` block carrying the exact `curl` body the
  operator could submit. The `manual_equivalent.newtron_http.status`
  is `"pending_newtron_gap"` against newtron#9 until newtron exposes
  the raw-intent endpoint; today, the substrate-faithful manual
  equivalent is the typed-verb endpoint chosen by the operation
  (e.g., `apply-service` → newtron's existing `apply-service`
  endpoint), surfaced as `partial_match` in
  [§Decomposition Browser](#get-apimanual_decompositionoperation_kindoperation_id)
  below.
- **`execution_order`** follows Workbench's ordering policy: in v0,
  alphabetic by Node name unless an intent declares a parent on a
  different Node (cross-Node parents are forbidden by newtron's DAG
  per `intents.md` §2 — parents are device-local — so v0's policy
  reduces to alphabetic ordering for multi-Node submissions).
- **`cross_node_atomicity`** is `null` when `node_count == 1`
  (matching Workbench's omission rule). When `node_count > 1`, it
  carries `atomic: false` and the same operator-consequence
  explanation Workbench's commit-preview uses.
- **`disruption.rationale[]`** follows the same shape as elsewhere:
  each entry names the input, its value, and the contribution to
  the verdict. A rationale array empty of the inputs that justify
  the verdict is a contract violation.
- **`preflight`** mirrors Workbench's commit-preview preflight: a
  read-side check at preview time; the apply response reports actual
  outcome.

A drift-guard refusal on any target → 409 with
`kind: "drift_refusal"` and `details` per the typed schema in §Error
Schema. `details.per_target[*].drift_entries[]` carries the
`DriftEntry[]` shape (same as Inbox drift card). The preview is not
returned.

A validation failure (the intent fails I4, the operation is unknown,
the resource key violates `intents.md` §7) → 400 with
`kind: "validation_failure"` and `details` per the typed schema in
§Error Schema. The operator fixes the submission before re-preview.

**Errors:**
- Unknown `operation` or invalid `resource_key` → 400
  `validation_failure` per the typed schema.
- I4 failure (declared parent does not exist on the Node) → 400
  `validation_failure` with `details.rejections[*].reason ==
  "target_absent"` and
  `details.rejections[*].locator.substrate_field` naming the missing
  parent.
- I5 implications (the operation would create children that already
  exist with different parents) → 400 `validation_failure` with the
  conflict surfaced.
- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.
- newtron-server unreachable → 503 `newtron_unavailable` per the
  typed schema in §Error Schema.

### `POST /api/intents`

Apply a previously-generated intent submission preview. Atomicity
follows the operator's `atomicity_intent` choice and the per-Node
guarantee documented in [§Workbench](#endpoints--change-workbench-third-surface)
— each per-Node call is atomic via TxPipeline; the cross-Node sequence
is not atomic. Returns one `operation_id` per intent (or per per-Node
bundle, when `atomicity_intent == "per_node"`), with the full pipeline
trace + Device I/O verify assertion per intent.

**Request:**
```json
{
  "preview_id": "<from POST /api/intents/preview>",
  "stop_on_first_failure": true
}
```

`stop_on_first_failure` has identical semantics to Workbench's commit:
`true` (default) halts the cross-Node sequence on a per-Node failure;
`false` continues. Within a per-Node bundle, the TxPipeline is atomic
regardless of this flag — a failure inside the bundle rolls back the
bundle (per `unified-pipeline-architecture.md` §8 Lock/snapshot/restore
cycle).

**Response 200:**
```json
{
  "applied_at": "2026-05-26T14:09:00Z",
  "per_intent": [
    {
      "intent_index": 0,
      "operation": "apply-service",
      "network": "default",
      "node": "switch1",
      "resource_key": "interface|Ethernet0",
      "status": "applied | failed | not_attempted",
      "intent_id": "<opaque>",
      "intent_url": "/api/intents/<opaque>",
      "operation_id": "<opaque, present when status != not_attempted>",
      "operation_url": "/api/operations/<opaque>",
      "pipeline": {
        "intent":  { "stage": "complete", "at": "2026-05-26T14:09:00Z" },
        "replay":  { "stage": "complete", "at": "2026-05-26T14:09:00Z" },
        "render":  { "stage": "complete", "at": "2026-05-26T14:09:01Z" },
        "deliver": { "stage": "complete", "at": "2026-05-26T14:09:02Z" }
      },
      "verify": {
        "kind": "device_io_assertion",
        "state": "in_progress",
        "started_at": "2026-05-26T14:09:02Z",
        "verify_url": "/api/operations/<opaque>/verify"
      },
      "intent_record": {
        "key": "interface|Ethernet0",
        "fields": { /* NEWTRON_INTENT record actually written, including resolved params */ }
      },
      "resolved_params_origin": "newtron_resolved",
      "failure": null
    }
  ],
  "per_node_results": [
    {
      "node": "switch1",
      "status": "applied",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 1,
      "operation_ids": ["<opaque>"]
    }
  ],
  "aggregate": {
    "outcome": "all_applied | partial | none_applied",
    "node_count_applied": 1,
    "node_count_failed": 0,
    "node_count_not_attempted": 0,
    "verify_pending_intents": 1,
    "stop_on_first_failure_triggered": false
  },
  "cross_node_atomicity": null
}
```

Field rules:

- **`per_intent[*].status`**:
  - `applied` — newtron's write returned success for this intent's
    per-Node bundle; verify may still be in progress (post-deliver
    Device I/O per `unified-pipeline-architecture.md` §7).
  - `failed` — newtron's write failed on this intent's per-Node
    bundle. The whole per-Node bundle is failed (per-Node atomicity);
    the `failure` object carries the substrate-level error.
  - `not_attempted` — the cross-Node sequence was halted before this
    intent's Node was reached (only possible when
    `stop_on_first_failure: true`).
- **`per_intent[*].intent_id`** and **`per_intent[*].intent_url`**
  are the durable navigation links to the dedicated Provenance surface
  at [`GET /api/intents/{intent_id}`](#get-apiintentsintent_id). A
  manually-submitted intent is indistinguishable from any other
  intent in the Provenance surface — the operator clicks through and
  inspects the substrate the same way. Per operator-philosophy
  invariant #2's "same surface" requirement, the manual path and the
  automation path produce the same provenance.
- **`per_intent[*].pipeline`** and **`per_intent[*].verify`** mirror
  the shape defined in [§Operations](#endpoints--operations) exactly:
  four pipeline stages, plus a top-level `verify` typed
  `device_io_assertion`. Deliver always lands on the real device;
  there is no `target` discriminator because newtcon does not provide
  a tool-mediated rehearsal sandbox — rehearsal is the operator
  practicing on their own lab device with their own tools (see
  [§Endpoints — Rehearsal](#endpoints--rehearsal-teaching-surface)
  for the teaching content).
- **`per_intent[*].intent_record.fields`** is the NEWTRON_INTENT
  record actually written, including the resolved params half. Per
  `DESIGN_PRINCIPLES_NEWTRON.md` §1, §22, the intent record IS the
  decision substrate; the apply response surfaces it directly so the
  operator never has to follow a link to read what was actually
  recorded.
- **`per_intent[*].resolved_params_origin`** is the discriminator
  echoed from the preview. Per §22, the operator (and any future
  reader) can tell whether the resolved params were spec-derived or
  operator-supplied at submission time.
- **`per_intent[*].failure`** uses the same five-`kind` typed shape
  as Workbench's per-target failure (see §Error Schema). The
  `kind` values match newtron's substrate-level error
  classifications; `stage` names which pipeline stage produced the
  failure (`intent | replay | render | deliver`).
- **`aggregate.outcome`** semantics: `all_applied` (every per-Node
  result is `applied`), `partial` (at least one applied and at least
  one of `{failed, not_attempted}`), `none_applied` (no Node
  applied).
- **`cross_node_atomicity`** is `null` when `node_count == 1` and
  carries `atomic: false` with operator-consequence explanation
  when `node_count > 1`. The contract rejects `atomic: true` on
  principle, matching Workbench.

**Errors:**
- Stale or already-consumed `preview_id` → 410 Gone with
  `kind: "precondition_failure"`.
- `preview_id` was issued by a different endpoint than this one (a
  wrong-class preview) → 409 `precondition_failure` with
  `condition: "preview_id_wrong_class"`,
  `condition_details: { preview_id, received_kind, required_kind: "intent_submission_preview" }`.
- newtron unreachable for any target Node → 503
  `newtron_unavailable` per the typed schema in §Error Schema.
- A drift-guard refusal mid-pipeline → 409 `drift_refusal`. The
  operator re-previews.
- Catastrophic newtcon-server failure mid-sequence → 502 with
  `kind: "internal"`. `details.partial_results` carries the per-Node
  results completed before the failure (shape matches this
  endpoint's success-response `per_intent[]`).

### `POST /api/configdb/{network}/{node}/{table}/{key}/write/preview`

Preview a direct CONFIG_DB key write against a non-newtron-owned
table. **No newtron-side mutation.** Returns the would-be entry, the
prior fields (if the key currently exists), the per-Node atomicity
classification, and the substrate-grounded refusal of any write that
targets a newtron-owned table. Mandatory before
`POST .../write` per `CLAUDE.md` §Preview Before Commit, Always.

**Why this endpoint exists.** Per `DESIGN_PRINCIPLES_NEWTRON.md` §1,
every newtron-owned write flows through `writeIntent` so the intent DB
stays authoritative. But SONiC's CONFIG_DB contains tables newtron does
NOT own (third-party-managed tables, vendor extensions, operator-side
custom tables). For non-newtron-owned tables, the substrate-truth
write path is `redis-cli HSET` on the device — a path newtcon would
otherwise be unable to surface (the newtron HTTP boundary forbids
direct Redis access from newtcon, per `CLAUDE.md` §newtron-api-consumption-rule).
Operator-philosophy invariant #2 binds: the operator who must SSH to
the device for one third-party table is a Manual-mode parity gap.

This endpoint surfaces the gap honestly: the substrate path lives in
newtron (see [newtron#10](https://github.com/aldrin-isaac/newtron/issues/10)),
and newtcon's contract surface is `pending_newtron_gap` until that
endpoint lands.

**Path parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `network` | string | Network name (the same `network` the operator scopes elsewhere). |
| `node` | string | Node name. |
| `table` | string | CONFIG_DB table name. MUST be a non-newtron-owned table; the endpoint refuses newtron-owned tables (see below). |
| `key` | string | CONFIG_DB key inside the table. URL-encoded (Redis `|` separators in keys are `%7C` on the wire). |

**Request:**
```json
{
  "operation": "set | delete",
  "fields": { "field1": "value1", "field2": "value2" },
  "non_newtron_owned_attestation": {
    "operator_acknowledges": true,
    "rationale": "<free text the operator supplies explaining why a non-newtron-owned table is being written>"
  }
}
```

Field rules:

- **`operation`** is the discriminator: `set` (HSET fields on the
  key) or `delete` (DEL the key). Bounded enum.
- **`fields`** is REQUIRED when `operation == "set"`, FORBIDDEN
  otherwise. An empty `fields` object on `set` is rejected with 400
  `validation_failure` (the operator must name what is being set,
  not implicitly clear).
- **`non_newtron_owned_attestation`** is the operator's explicit
  acknowledgement that the write is outside newtron's domain. Per
  operator-philosophy invariant #9 ("confidence and limits are
  explicit"), the contract makes the operator's choice visible
  rather than silently implying it. The `rationale` is captured for
  operations-history audit; an empty rationale is rejected with 400
  `validation_failure`.

**Response 200 (preview of an allowed write):**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "network": "default",
  "node": "switch1",
  "table": "DEVICE_METADATA_VENDOR_EXT",
  "key": "vendor-token",
  "operation": "set",
  "would_write_fields": { "field1": "value1", "field2": "value2" },
  "prior_fields": { "field1": "older_value" },
  "delta": {
    "added_fields": [],
    "removed_fields": [],
    "modified_fields": ["field1"],
    "unchanged_fields": []
  },
  "ownership": {
    "newtron_owned": false,
    "owning_subsystem": "vendor-extension (operator-asserted)",
    "newtron_drift_detection_applies": false,
    "newtron_intent_record_produced": false
  },
  "per_node_atomicity": {
    "atomicity": "atomic_via_redis_hset",
    "atomicity_rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
    }
  },
  "disruption": {
    "config_reload": false,
    "bgp_restart": false,
    "estimated_data_plane_impact": "unknown (non-newtron-owned table; newtron has no semantic model)",
    "rationale": [
      { "input": "table", "value": "DEVICE_METADATA_VENDOR_EXT", "contribution": "unknown (operator-asserted non-newtron-owned)" }
    ]
  },
  "verify_intent": {
    "supported": false,
    "rationale": "newtron's Verify (Device I/O assertion, unified-pipeline-architecture.md §7) re-reads the ChangeSet and diffs against captured-expected. A direct CONFIG_DB write produces no ChangeSet provenance newtron can re-assert against. The operator is responsible for verifying the write by hand (newtcon will re-read the key after apply and surface the post-write fields).",
    "verify_rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else"
    }
  },
  "manual_equivalent": {
    "newtron_cli": "redis-cli -h switch1 -p 6379 HSET 'DEVICE_METADATA_VENDOR_EXT|vendor-token' 'field1' 'value1' 'field2' 'value2'",
    "newtron_http": {
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/10",
      "expected_shape": {
        "method": "POST",
        "path": "/network/default/node/switch1/configdb/DEVICE_METADATA_VENDOR_EXT/vendor-token",
        "query": { "dry_run": "false" },
        "body": {
          "fields": { "field1": "value1", "field2": "value2" },
          "non_newtron_owned_attestation": { "operator_acknowledges": true, "rationale": "<echoed>" }
        }
      }
    }
  }
}
```

Field rules:

- **`would_write_fields`** is what `set` would HSET (or, for
  `delete`, omitted with `prior_fields` documenting what would be
  removed).
- **`prior_fields`** is captured at preview-render time; `null` when
  the key does not currently exist. Per
  `unified-pipeline-architecture.md` §8's
  `Lock → snapshot → fn → commit-or-restore → Unlock` cycle,
  prior-state capture is a substrate property of the write path; the
  preview exposes it so the operator sees what would change.
- **`delta`** is the field-level diff between `prior_fields` and
  `would_write_fields`. For `delete`, only `removed_fields` is
  populated (all of `prior_fields.keys()`).
- **`ownership.newtron_owned`** is `false` for every successful
  preview — the endpoint refuses newtron-owned writes (see Errors).
  Surfaced as a load-bearing field so the consumer renders the
  "outside newtron's domain" semantics distinctively.
- **`ownership.newtron_drift_detection_applies`** is `false` because
  drift detection (`unified-pipeline-architecture.md` §8 Drift Guard)
  operates against newtron-owned tables only. The operator is told
  explicitly: writes to this key will not trip drift refusals on
  subsequent newtron operations, AND newtron will not detect
  external mutations to this key.
- **`ownership.newtron_intent_record_produced`** is `false` — no
  NEWTRON_INTENT record is written. The write is recorded in
  newtcon-server's operation history with a `raw_configdb_write`
  classification, and (per newtron#10's expected design) in
  newtron's own history as well.
- **`per_node_atomicity.atomicity`** is `atomic_via_redis_hset` for
  `set` operations (the per-Node TxPipeline wraps the HSET in the
  same Lock/Unlock cycle as every other write).
  `atomic_via_redis_del` for `delete`. The enum extends the existing
  `per_node_atomicity.atomicity` enum used by Workbench
  (`atomic_via_txpipeline`, `atomic_via_replaceall`,
  `atomic_via_applydrift`, `not_atomic_with_rationale`) with these
  two new values, bounded.
- **`disruption.estimated_data_plane_impact`** is
  `"unknown (non-newtron-owned table; newtron has no semantic
  model)"` for every preview of this kind. Per operator-philosophy
  invariant #9, the contract is honest: newtron cannot predict
  service-affecting impact on a table whose semantics it does not
  model. The operator owns the disruption assessment.
- **`verify_intent`** is the contract's surface-level acknowledgment
  that newtron's Verify (Device I/O assertion) does not apply to
  this write. `supported: false` is binding; consumers must NOT
  render a "verified" status on direct-write applies.
- **`manual_equivalent.newtron_cli`** is the literal `redis-cli`
  command the operator could run if they SSH'd to the device. Per
  operator-philosophy invariant #2, the manual ground-truth path is
  surfaced verbatim.

**Errors (refusals at preview time):**

- **`table` is in newtron's owned-tables set** → 400
  `validation_failure` with `details.rejections[*].reason ==
  "newtron_owned_table_forbidden"`,
  `details.rejections[*].locator.substrate_field.table` naming the
  refused table, and `details.rationale_ref.principle ==
  "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"`.
  The rejection's `message` points the operator at
  `POST /api/intents/preview` with an `operation` that targets the
  table's owning intent. Per operator-philosophy invariant #7
  ("errors carry the substrate"), the refusal is teaching, not
  scolding — it names the substrate reason (the table is known AND
  newtron-owned, so direct write is architecturally forbidden) and
  points the operator at the correct manual path. `unknown_table`
  is reserved for its substrate meaning (the named table is not
  recognized at all); `newtron_owned_table_forbidden` is the
  dedicated reason for this refusal.
- **Unknown `network`, `node`, or `table` not present on the
  device** → 400 `validation_failure` with the appropriate
  `details.rejections[*].locator.substrate_field`.
- **Empty `fields` on a `set` operation, or empty `rationale` on
  the attestation** → 400 `validation_failure`.
- **newtron-server reachable but does not expose the direct-write
  endpoint** (the typical case today, until newtron#10 lands) →
  501 with `kind: "precondition_failure"`,
  `condition: "newtron_capability_missing"`,
  `condition_details.gap_issue_url:
  "https://github.com/aldrin-isaac/newtron/issues/10"`. The preview
  is not returned. Per `CLAUDE.md` §Gap-Handling Protocol, the
  endpoint is contractually defined here but operationally blocked
  until newtron exposes the substrate path.
- newtron-server unreachable → 503 `newtron_unavailable`.

### `POST /api/configdb/{network}/{node}/{table}/{key}/write`

Apply a previously-generated direct CONFIG_DB write preview.
Atomicity follows the per-Node guarantee — the write goes through
newtron's per-device actor and shares the same Lock/Unlock cycle as
every other write to that Node. A failure inside the cycle is rolled
back per `unified-pipeline-architecture.md` §8.

**Request:**
```json
{
  "preview_id": "<from POST .../write/preview>"
}
```

**Response 200:**
```json
{
  "network": "default",
  "node": "switch1",
  "table": "DEVICE_METADATA_VENDOR_EXT",
  "key": "vendor-token",
  "operation": "set",
  "applied_at": "2026-05-26T14:10:00Z",
  "operation_id": "<opaque>",
  "operation_url": "/api/operations/<opaque>",
  "applied_fields": { "field1": "value1", "field2": "value2" },
  "prior_fields": { "field1": "older_value" },
  "newtcon_post_write_readback": {
    "captured_at": "2026-05-26T14:10:01Z",
    "fields": { "field1": "value1", "field2": "value2" },
    "matches_intent": true
  },
  "ownership": {
    "newtron_owned": false,
    "newtron_drift_detection_applies": false,
    "newtron_intent_record_produced": false
  },
  "verify": {
    "kind": "device_io_assertion",
    "state": "skipped",
    "skip_reason": "non_newtron_owned_table",
    "skip_reason_rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else"
    }
  },
  "operator_attestation_recorded": {
    "rationale": "<from preview>",
    "recorded_at": "2026-05-26T14:10:00Z"
  }
}
```

Field rules:

- **`applied_fields`** is what was actually HSET (echo of
  `would_write_fields`).
- **`prior_fields`** is what was overwritten — the pre-write
  snapshot from preview, captured by newtron's
  `Lock → snapshot → fn → commit → Unlock` cycle.
- **`newtcon_post_write_readback`** is a courtesy re-read of the
  key after apply, performed by newtcon-server. It is NOT a Verify
  in newtron's sense (which is an assertion against a ChangeSet) —
  it is a substrate-readback the operator can compare against
  `applied_fields`. `matches_intent` is `true` when every field in
  `applied_fields` is present in `fields` with the same value;
  `false` otherwise. Per operator-philosophy invariant #1 ("no
  black boxes"), the readback is surfaced so the operator can spot
  a daemon-rejected write even though Verify-proper does not apply.
- **`verify.state`** is **always `"skipped"`** with
  `skip_reason: "non_newtron_owned_table"`. Verify is a Device I/O
  assertion against a ChangeSet (`unified-pipeline-architecture.md`
  §7); this write has no ChangeSet to assert against. Surfacing
  `verify.state == "complete"` would teach the operator a false
  model of where verification provenance lives — per
  operator-philosophy invariant #1, forbidden.
- **`operator_attestation_recorded`** echoes the rationale from
  preview and records the server-side timestamp. The operator's
  narrative survives the write, queryable from the operations
  endpoint for the operation's retention window.

**Errors:**
- Stale or already-consumed `preview_id` → 410 Gone with
  `kind: "precondition_failure"`.
- newtron-server unreachable mid-apply → 503 `newtron_unavailable`.
- The write succeeded but post-write readback shows a mismatch
  (daemon rejection) → 200 with `newtcon_post_write_readback.matches_intent
  == false` and `applied_fields` reflecting the readback. The
  operator is told what landed; no error is raised because the
  write itself succeeded — the daemon's reaction is a downstream
  substrate event the operator interprets.

### `GET /api/manual_decomposition/{operation_kind}/{operation_id}`

Return the step-by-step manual decomposition of an automated action —
the sequence of intent submissions (or per-CONFIG_DB-key writes) the
operator would execute by hand to reproduce the same effect. Idempotent;
safe to poll. No newtron-side state is mutated.

**Why this endpoint exists.** Operator-philosophy invariant #2's
"anything the automation can do, the operator can do by hand" is
binding only if the operator can SEE the decomposition. Without this
endpoint, a Composer apply that writes 8 intent records (one
ApplyService, plus VRF/ACL/route-map derived intents) is opaque at
the manual level — the operator knows it ran but cannot rehearse
the manual sequence that would have done the same. With this
endpoint, the operator opens any operation and reads the exact list
of intent submissions, in order, that would reproduce it.

**Path parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `operation_kind` | string | One of `composer_preview`, `composer_apply`, `inbox_action_preview`, `inbox_action`, `workbench_commit_preview`, `workbench_commit`, `workbench_revert_preview`, `workbench_revert`, `intent_submission_preview`, `intent_submission`, `configdb_write_preview`, `configdb_write`. Bounded enum. The two `configdb_write*` kinds decompose direct CONFIG_DB writes — typically a single step at `decomposition_level: per_configdb_keys` (the write IS its own substrate), and `equivalence_to_original.kind == "exact"` because no further decomposition exists. |
| `operation_id` | string (opaque) | The newtcon-side ID of the operation to decompose. For `composer_apply`/`inbox_action`/`workbench_commit`/`intent_submission`/`configdb_write`, the `operation_id` minted by the corresponding apply endpoint. For preview-class kinds, the `preview_id`. |

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `decomposition_level` | string | `intent_submissions` | One of `intent_submissions` (the operator's first-class manual lever), `per_configdb_keys` (the lowest-level decomposition; expands intent submissions into the per-table-per-key writes they produce; useful for forensic-level inspection of what a write actually does in CONFIG_DB), `verb_endpoints` (the per-verb newtron HTTP endpoints; a middle-ground for operators who prefer the typed-verb path over raw-intent submission). |

**Response 200:**
```json
{
  "operation_kind": "composer_apply",
  "operation_id": "<echoed>",
  "operation_url": "/api/operations/<opaque>",
  "decomposition_level": "intent_submissions",
  "as_of": "2026-05-26T14:11:00Z",
  "steps": [
    {
      "step": 1,
      "purpose": "Create parent VRF intent (newtron's spec resolution decided this was required because the service spec declared a VRF that did not yet exist).",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#724-applyservice",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      },
      "newtcon_endpoint": {
        "method": "POST",
        "path": "/api/intents/preview",
        "body": {
          "intents": [
            {
              "operation": "create-vrf",
              "network": "default",
              "node": "switch1",
              "resource_key": "vrf|Vrf_TRANSIT",
              "name": "Vrf_TRANSIT",
              "state": "actuated",
              "user_params": { "name": "Vrf_TRANSIT" },
              "parents": ["device"],
              "resolved_params_strategy": "let_newtron_resolve"
            }
          ]
        }
      },
      "newtron_substrate_call": {
        "manual_equivalent": {
          "newtron_cli": "newtron switch1 create-vrf --name Vrf_TRANSIT",
          "newtron_http": {
            "status": "available",
            "method": "POST",
            "path": "/network/default/node/switch1/create-vrf",
            "body": { "name": "Vrf_TRANSIT" }
          }
        }
      },
      "produces_intents": ["vrf|Vrf_TRANSIT"],
      "produces_configdb_keys": [
        { "table": "VRF", "key": "Vrf_TRANSIT" },
        { "table": "NEWTRON_INTENT", "key": "vrf|Vrf_TRANSIT" }
      ]
    },
    {
      "step": 2,
      "purpose": "Submit the primary ApplyService intent. With the VRF parent now present, I4 is satisfied. resolved_params_strategy: let_newtron_resolve so newtron computes content-hashed route-map and ACL references at submission time.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#724-applyservice",
        "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
      },
      "newtcon_endpoint": {
        "method": "POST",
        "path": "/api/intents/preview",
        "body": {
          "intents": [
            {
              "operation": "apply-service",
              "network": "default",
              "node": "switch1",
              "resource_key": "interface|Ethernet0",
              "name": "transit",
              "state": "actuated",
              "user_params": { "service": "transit", "ip_address": "10.1.0.0/31", "peer_as": 65002 },
              "parents": ["vrf|Vrf_TRANSIT", "service|transit"],
              "resolved_params_strategy": "let_newtron_resolve"
            }
          ]
        }
      },
      "newtron_substrate_call": {
        "manual_equivalent": {
          "newtron_cli": "newtron switch1 apply-service --interface Ethernet0 --service transit --ip 10.1.0.0/31 --peer-as 65002",
          "newtron_http": {
            "status": "available",
            "method": "POST",
            "path": "/network/default/node/switch1/apply-service",
            "body": {
              "interface": "Ethernet0",
              "params": { "service": "transit", "ip_address": "10.1.0.0/31", "peer_as": 65002 }
            }
          }
        }
      },
      "produces_intents": ["interface|Ethernet0", "service|transit", "route-map|TRANSIT_IN_A1B2C3D4", "..."],
      "produces_configdb_keys": [
        { "table": "BGP_NEIGHBOR", "key": "default|10.1.0.1" },
        { "table": "INTERFACE", "key": "Ethernet0" },
        { "table": "ROUTE_MAP", "key": "TRANSIT_IN_A1B2C3D4" },
        { "table": "NEWTRON_INTENT", "key": "interface|Ethernet0" }
      ]
    }
  ],
  "step_count": 2,
  "ordering_rationale": "Steps are ordered to satisfy intent DAG invariant I4 (parents must exist before children, per newtron/docs/newtron/intents.md §2): VRF intent first because the ApplyService intent declares it as a parent.",
  "ordering_rationale_ref": {
    "substrate": "newtron/docs/newtron/intents.md#2-dag-invariants",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#20-on-device-intent-is-sufficient-for-reconstruction"
  },
  "equivalence_to_original": {
    "kind": "exact | partial | structurally_equivalent",
    "rationale": "Step-by-step manual submissions through /api/intents are bit-equivalent to what newtcon's Composer apply executed: same operation verbs, same resource keys, same user params, same parents, same resolved_params_strategy. The decomposition's ChangeSets are bit-identical to the original's ChangeSets, modulo timestamps."
  },
  "equivalence_rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#2-one-pipeline",
    "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
  },
  "rehearsal_hint": {
    "verb": "browse_walkthroughs_and_practice_on_lab_device",
    "endpoint": "/api/rehearsal/walkthroughs",
    "rationale": "To practice this decomposition without affecting production, browse the Rehearsal teaching surface for a walkthrough that exercises the same substrate (drift recovery, zombie cleanup, partial-commit recovery, etc.), and execute the walkthrough's forward_cli steps on a lab device you own. The walkthroughs use ssh + redis-cli + vendor CLI directly against the lab device, so the practice rehearses the operator's-own-tools path that this decomposition would execute manually."
  }
}
```

Field rules:

- **`decomposition_level`** is the discriminator for the granularity
  of the decomposition. `intent_submissions` is the default and the
  operator's first-class manual lever — it matches the surface the
  operator can drive directly via `/api/intents`. `per_configdb_keys`
  is the deepest forensic view — each intent submission expands to
  the per-table-per-key writes the Render stage would produce.
  `verb_endpoints` is the middle ground: the typed-verb newtron HTTP
  endpoints (e.g., `apply-service`, `create-vlan`) that the
  automation chose internally; useful for operators who prefer to
  hand-call newtron's verb catalog rather than submit raw intents.
- **`steps[*].purpose`** is the substrate-grounded rationale for the
  step's existence — WHY this step is in the decomposition. Per
  operator-philosophy invariant #5 ("why-mode is always available"),
  every step explains itself in the substrate's own terms. Empty or
  generic `purpose` strings are a contract smell; the Architecture
  Reviewer rejects decomposition responses with non-substrate-grounded
  purpose text.
- **`steps[*].newtcon_endpoint`** is the EXACT newtcon HTTP call the
  operator would issue to execute this step manually. The body is
  copy-pasteable into the operator's HTTP client.
- **`steps[*].newtron_substrate_call.manual_equivalent`** is the
  underlying newtron HTTP call (or CLI) the step's
  `newtcon_endpoint` would internally translate to. Surfaced so the
  operator who prefers calling newtron directly (bypassing newtcon)
  can do so. Per operator-philosophy invariant #2, both paths are
  legitimate; the contract surfaces both.
- **`steps[*].produces_intents[]`** lists the resource-keys of every
  intent record this step writes. Per `DESIGN_PRINCIPLES_NEWTRON.md`
  §1, the intent record IS the decision substrate; surfacing what
  intents each step produces lets the operator trace step → intent →
  Provenance directly.
- **`steps[*].produces_configdb_keys[]`** lists the CONFIG_DB
  table+key pairs the step's Render stage writes. The list is
  derived from newtron's render-time logs (today exposed in process
  logs; expected to come through structured render-decisions in
  future, per the gap on the §ChangeSet endpoint).
- **`ordering_rationale`** explains why steps are in this order.
  For decompositions that span multiple intents with DAG
  dependencies, ordering MUST satisfy I4 (parents before children).
  An ordering violation is a contract violation.
- **`equivalence_to_original.kind`** discriminates:
  - `exact` — the decomposition reproduces the original
    bit-for-bit modulo timestamps. Available when the original was
    itself an `/api/intents` submission or when the per-verb
    automation has a clean intent-decomposition.
  - `partial` — the decomposition reproduces a subset of the
    original's effects; remaining effects cannot be reproduced via
    the requested `decomposition_level`. The `rationale` names what
    is missing and why. Used, e.g., when the automation invoked a
    baseline operation (`setup-*`, `set-*`) whose individual
    reverse is `Reconcile()` (per
    `DESIGN_PRINCIPLES_NEWTRON.md` §15) and cannot be decomposed
    further at the chosen level.
  - `structurally_equivalent` — the decomposition produces the same
    set of intent records and ChangeSet entries but through a
    different ordering than the automation chose. Used for
    decompositions where the operator's manual ordering is
    permissible (does not violate I4) but does not match the
    automation's chosen order.
- **`equivalence_to_original.kind == "partial"`** with a non-empty
  rationale is HONEST, not a defect. Per operator-philosophy
  invariant #9 ("confidence and limits are explicit"), the
  decomposition surface acknowledges when it cannot fully decompose
  rather than fabricating a "complete" decomposition that would
  mislead the operator.
- **`rehearsal_hint`** is REQUIRED. The decomposition surface is
  inert without rehearsal — reading the decomposition is teaching;
  practicing it on a lab device the operator owns is capability-
  amplification. Per operator-philosophy invariant #6 ("rehearsal
  mode is real" — reframed: rehearsal is real-tool rehearsal on
  operator-owned hardware, not a tool-mediated sandbox), the
  decomposition surface always points to the
  [§Endpoints — Rehearsal (teaching surface)](#endpoints--rehearsal-teaching-surface),
  whose walkthroughs are practiced on the operator's lab device with
  the operator's own tools.

**Errors:**
- Unknown `operation_kind` → 400 `validation_failure` with
  `details.rejections[*].reason == "unknown_value"` and
  `details.rejections[*].allowed` carrying the bounded enum.
- Unknown or evicted `operation_id` → 404 with
  `kind: "precondition_failure"` and the appropriate condition
  (`operation_unknown_or_expired`, `operation_evicted`, or
  `preview_id_unknown` per the original operation class).
- newtron-server unreachable → 503 `newtron_unavailable` per the
  typed schema in §Error Schema.

### Manual-mode parity composes with the Rehearsal teaching surface

The Manual-Mode Parity surface and the Rehearsal teaching surface are
two halves of one capability-amplification arc, and they compose
without any Rehearsal-scoped sibling endpoint:

- The Manual-Mode Parity surface (this section) gives the operator
  the **production manual lever** — hand-authoring an intent, writing
  a non-newtron-owned CONFIG_DB key, reading the decomposition of any
  automated action. These are real endpoints that execute against
  real devices.
- The Rehearsal teaching surface (see
  [§Endpoints — Rehearsal](#endpoints--rehearsal-teaching-surface))
  gives the operator the **practice ground for the operator's own
  tools** — walkthroughs of failure scenarios that the operator
  executes on a lab device they own, using ssh + redis-cli + vendor
  CLI directly. The walkthroughs do not invoke any production
  endpoint; they teach the substrate so the operator can practice
  independently.

Per the refined operator-philosophy invariant #2 (manual-mode parity
lives in the operator's own tools, not in newtcon's affordances) and
the reframed invariant #6 (rehearsal must rehearse the case where
newtron is the failure mode), there is no `POST
/api/rehearsal/sessions/{sid}/intents` style sibling for these
manual-mode endpoints. Such a sibling would be newtron-mediated
rehearsal, which the reframe rejects. The Rehearsal teaching surface
is read-only by construction; the practice happens on the operator's
lab device.

When the operator wants to practice hand-authoring an intent before
submitting it in production, the workflow is:

1. Read the walkthrough nearest to the intended manual action via
   [`GET /api/rehearsal/walkthroughs`](#get-apirehearsalwalkthroughs).
2. Execute the walkthrough's `forward_cli` steps on a lab device the
   operator owns. The lab-device guidance section names the
   recommended setup.
3. Once comfortable, return to this surface and submit the real
   intent against the production node via
   [`POST /api/intents/preview`](#post-apiintentspreview) followed by
   [`POST /api/intents`](#post-apiintents).

The shape the operator submits in step 3 is the exact shape this
contract defines — there is no parallel "rehearsal shape" to learn.
Operator-philosophy invariant #2's "same surface" requirement binds
on the production submission; the teaching surface teaches the
underlying substrate the submission travels through, not a parallel
universe.

### Out of scope for v0 (deferred Contract PRs)

The following extensions are deliberately deferred:

- **Bulk intent import from a file.** v0 accepts intents inline in the
  request body. A file-upload variant (the operator uploads a
  newline-delimited JSON of intent submissions) is deferred until a
  concrete operator workflow demands it.
- **Intent template authoring.** v0 hand-authors each intent. Templates
  ("apply this intent shape across these N nodes with parameter
  variation") are an operator-defined automation capability per
  operator-philosophy invariant #8 and land in a follow-up Contract PR
  alongside the broader operator-defined automation surface.
- **`set-*` and baseline-verb manual decomposition.** Baseline
  operations (`setup-*`, `set-*`) per `DESIGN_PRINCIPLES_NEWTRON.md`
  §15 have no individual reverse; their decomposition through the
  Manual-mode parity surface emits
  `equivalence_to_original.kind == "partial"` with an explanatory
  rationale. A first-class "baseline manual" surface that decomposes
  `setup-device` into its sub-operations is deferred until newtron
  exposes sub-operation handles.

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
  window as the originating operation. See
  [newtcon#18](https://github.com/aldrin-isaac/newtcon/issues/18)
  for the operation-retention contract (minimum 30 minutes
  post-terminal-state pinned today; full retention contract lands in
  a follow-up Contract PR). A `changeset_id` whose underlying
  operation has been evicted returns 404 with
  `details.reason: "operation_evicted"`.
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
      "substrate": "newtron/docs/newtron/intents.md#34-validateintentdag",
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
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/5",
      "expected_shape": {
        "method": "GET",
        "path": "/network/default/node/switch1/projection",
        "query": { "table": "<repeatable>", "mode": "actuated|topology" }
      }
    }
  }
}
```

Field rules:

- **`as_of` and `rebuilt_at`** are deliberately separate fields.
  `as_of` is when newtcon-server completed the underlying read;
  `rebuilt_at` is when newtron last replayed intents to rebuild the
  projection. On `GET .../projection` the two coincide in the
  no-cache path, but the two-timestamp shape leaves room for an
  explicit cache to be introduced later (Architect-authored) per
  `docs/architecture.md` §Caching. Operator-philosophy invariant #9
  ("confidence and limits are explicit") is honored by surfacing
  the freshness of the substrate independently of the response
  envelope.
- **`tables[*].entries[*].owning_intent`** attributes each
  projection entry back to the intent record whose replay produced
  it. Per `unified-pipeline-architecture.md` §4-5, each render step
  is initiated by one config method whose intent is captured on the
  ChangeSet; the projection entry is rendered by exactly one such
  step. Attribution is the bridge that lets the operator click from
  a CONFIG_DB-shaped projection entry to the intent that caused it
  — the why-mode invariant materialized at the projection level.
- **`drift.summary`** is a lightweight inline counts-only view of
  `GET /network/{n}/node/{d}/drift` for the same Node, surfaced so
  the operator immediately knows whether the projection matches
  reality. The full drift entries are reached via the drift card
  (`drift_card_url` when non-null; null when `drift.summary.entry_count
  == 0`). The projection endpoint is the **what newtron believes**;
  the drift card is the **how reality differs**; both are reachable
  from each other.
- **`owned_tables_total`** carries the cardinality of
  `OwnedTables()` for the Node so the operator can see when a
  `table` filter is restricting the response.

**Why `pending_newtron_gap`:** newtron's projection is currently
exposed only as an in-memory side-effect of `Reconcile()` (which
also delivers) and as an opaque composite handle from
`generate-composite` (whose contents are not readable via `GET`).
There is no HTTP endpoint that returns the typed per-table
expected-state derived from intent replay as a pure read. The gap
was filed by the newtcon Architect at the time this contract was
written, per `CLAUDE.md` §Gap-Handling Protocol; see
[newtron#5](https://github.com/aldrin-isaac/newtron/issues/5) for
the proposed HTTP shape (which matches the `expected_shape` block
above). The implementer slice for this endpoint is blocked until
newtron#5 lands.

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
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/6",
      "expected_shape": {
        "method": "GET",
        "path": "/network/default/service/transit/projection",
        "query": { "node": "<repeatable>", "table": "<repeatable>" }
      }
    }
  }
}
```

Field rules:

- **`per_node[*].signal_unavailable`** uses the same pattern as the
  Inbox surface: a Node whose underlying signal is currently
  unreadable is NOT silently dropped (that would violate
  `CLAUDE.md` §No Hidden State). It appears with
  `signal_unavailable: true`, an empty `tables`, and a
  substrate-grounded reason. Aggregate counts split signal-present
  vs signal-unavailable.
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
  service-first navigation.
- **`shared_resource_summary[*].decision_on_service_remove`** is
  the decision newtron would make IF every binding of this service
  were removed. It is a hypothetical projection, not an action.
  Operator-philosophy invariant #4 ("show before do") is honored
  for the largest possible reverse operation on this service.
- **`per_node[*].rebuilt_at`** is per-Node because the read is
  per-Node; `null` when `signal_unavailable: true`. The top-level
  `as_of` is the timestamp at which newtcon-server completed the
  cross-Node fan-out.

**Why `pending_newtron_gap`:** there is no newtron HTTP endpoint
that returns a service-scoped projection slice across Nodes.
`/intent/tree?kind=service&resource={svc}` returns the intent-side
DAG for one device; the projection-side rendering of that DAG —
per-table, per-key, per-field — does not exist as an HTTP read on
either the per-Node or per-service axis. The gap was filed by the
newtcon Architect at the time this contract was written, per
`CLAUDE.md` §Gap-Handling Protocol; see
[newtron#6](https://github.com/aldrin-isaac/newtron/issues/6) for
the proposed HTTP shape. The implementer slice for this endpoint is
blocked until newtron#6 lands. (newtron#5 is a prerequisite of
newtron#6 — the per-Node projection read is the building block of
the per-service slice; newtron may choose to land #5 first.)

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
            "interpretation": "field missing on device after delivery; daemon may have rejected the write"
          }
        ]
      }
    ]
  },
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
  `expected`/`actual`/`interpretation`. The `interpretation` is a
  textual hint produced by newtcon-server — NOT a verdict on the
  device; it surfaces likely causes (daemon rejection, schema
  mismatch) so the operator has a starting point, not a
  conclusion.
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
  a new status value alongside `"available"` and
  `"pending_newtron_gap"`. It is used when an existing newtron
  endpoint answers a related but not identical question; the
  `note` explains the gap honestly. The bounded enum for
  `manual_equivalent.newtron_http.status` is therefore
  `available | pending_newtron_gap | partial_match | not_applicable`.

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
   hand-executed step and the actual outcome on their lab device, not
   between their action and an automated proposal. (The Manual-Mode
   Parity surface's `manual_decomposition` endpoint exposes the
   automation's decomposition; an operator who wants the comparison
   reads that endpoint and compares it against this walkthrough.
   Two different surfaces, two different purposes.)
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
newtcon.** When the operator drives a Composer apply, an Inbox action,
a Workbench commit, or a Manual-Mode-Parity intent submission, newtcon-
server IS the agent of the change. It captures the operation's
ChangeSet at apply time (per `CLAUDE.md` §Preview Before Commit and
the Provenance retention contract); it records the pipeline trace and
verify assertion (per §Endpoints — Operations); it knows the operator
identifier and the originating surface. The historical record of those
changes is therefore newtcon's responsibility by construction — newtron
holds the current intent records and the current device CONFIG_DB,
but the question "what did newtcon do, when, on whose behalf, with
what substrate effect?" is answered from newtcon's own retained
operation history (the `operation_url` / `intent_url` /
`changeset_url` companions surfaced on every change entry). The
observation polling layer is what extends that record to cover
out-of-band changes that newtcon did not initiate. The combined
surface — newtcon-mediated changes (authoritative) plus polled
observations (best-effort) — is what this contract section governs.

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
  Workbench commit, an Inbox action, a Manual-Mode-Parity intent
  submission, a Provisioning operation reported by newtron) by
  matching the substrate writes the operation produced against the
  diff between the prior and current observation. The
  `operation_url` companion field is populated.
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
  pending_newtron_gap | partial_match | not_applicable`.

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
      "rationale": "Observation history is newtcon-owned by design (see §Endpoints — Observation History, 'Why this lives in newtcon, not newtron'). No newtron HTTP endpoint exists or will exist; an operator reproducing this view manually polls newtron's existing reads (the bulk-CONFIG_DB and bulk-intent reads, pending newtron#17 and newtron#18) at the same cadence newtcon does and computes the diffs themselves. The operator's-tools alternative is to query newtcon's SQLite store directly: `sqlite3 <newtcon-state>/history.db 'SELECT ...'`."
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
  newtcon-server operation is still retained (per the operations
  retention contract; see newtcon#18). All three are `null` for
  `out_of_band` changes. For `newtron_mediated` changes whose
  operation has been evicted from operations retention, all three
  are `null` and `out_of_band_subkind` is `null` (the source is
  still `newtron_mediated` — the substrate's classification is
  durable even when the operation trace is not).
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
        "newtron_endpoint": "GET /network/default/node/switch1/configdb",
        "newtron_endpoint_status": "pending_newtron_gap",
        "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/17",
        "captured_at": "2026-05-26T13:58:00Z"
      },
      {
        "newtron_endpoint": "GET /network/default/node/switch1/intents",
        "newtron_endpoint_status": "pending_newtron_gap",
        "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/18",
        "captured_at": "2026-05-26T13:58:00Z"
      },
      {
        "newtron_endpoint": "GET /network/default/node/switch1/projection",
        "newtron_endpoint_status": "pending_newtron_gap",
        "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/5",
        "captured_at": "2026-05-26T13:58:00Z"
      }
    ]
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/17",
      "expected_shape": {
        "method": "GET",
        "path": "/network/default/node/switch1/configdb",
        "query": { "table": "<repeatable>", "owned_only": "true" }
      }
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
- **`observation.configdb`** is the raw `RawConfigDB` shape
  documented in newtron#17 — `table → key → field → value`. Same
  shape returned by the proposed newtron endpoint. Per §46, the
  wire shape mirrors the substrate.
- **`observation.intents[*]`** carries the raw NEWTRON_INTENT
  record fields per newtron#18.
- **`observation.projection`** is the projection captured at
  observation time per newtron#5. The shape is the same as the
  current `GET /api/projection/nodes/{node}` response under the
  `tables` key.
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
  used elsewhere (`available | pending_newtron_gap |
  partial_match | not_applicable`) so the operator knows which
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
      "rationale": "Per-change detail is computed by newtcon from its captured observations and the newtcon-server operations log; newtron has no equivalent endpoint because the change-history substrate (observation-over-time) is not newtron's substrate. The operator who reproduces this view manually polls the underlying newtron reads (newtron#17, newtron#18, newtron#5) and computes the diff themselves; or, when newtron is unavailable, runs the `undo_command_sequence` above against the device directly."
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
    commit, Manual-Mode-Parity intent submission). The
    correlation is not inferential; newtcon was the agent of the
    change and captured the operation_id at apply time. The
    observed diff is validated against the captured ChangeSet
    writes for substrate-consistency, but the correlation itself
    is authoritative — "historical changes made via newtcon must
    be maintained by newtcon" is operationalized at this level.
    Confidence: high.
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
   the four bounded values. For observation history, the
   typical answer is `not_applicable` (the substrate is
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
| `GET /api/intents/{intent_id}` (Provenance) | Inspect an intent record's substrate, DAG context, linked ChangeSets. | Carry call-site provenance for the failing write — that is the role of `PerWrite.source` (depends on [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)). |
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
- Replace manual classification. Until newtron#12 (call-site
  provenance) ships, the operator manually classifies
  newtron-vs-newtcon-vs-unknown via the request body. The surface
  still works without auto-classification — the body shape is
  identical, and the routing question is asked of the operator
  rather than inferred. When newtron#12 ships, the field becomes
  auto-populated; the operator may still override.

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
  Validated against newtcon-server's operations store; unknown or
  evicted → 400 with `kind: "precondition_failure"`,
  `details.condition: "operation_unknown_or_expired"`. Operations
  are retained per the operations retention contract (see
  §Endpoints — Operations and [newtcon#18](https://github.com/aldrin-isaac/newtcon/issues/18)
  for retention semantics); a report that references an evicted
  operation is refused because the report body's substrate cannot
  be reconstructed.
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
    using the `PerWrite.source` call-site if present (newtron#12);
    when `source` is null (newtron#12 not yet shipped, or this
    operation predates verbose-mode capture), `auto` resolves to
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
        "recent_operations_window_hint": "operations retained per §Endpoints — Operations retention; older operations may be absent"
      }
    },
    {
      "id": "call_site_provenance",
      "rendered_markdown": "**newtron call-site:** `pkg/newtron/network/node/bgp_ops.go:142 generateBgpNeighbor`\n\nThis is the Go method in newtron that emitted the failing CONFIG_DB write.",
      "substrate": {
        "source": { "call_site": "pkg/newtron/network/node/bgp_ops.go:142", "function": "generateBgpNeighbor" },
        "source_status": "available | pending_newtron_gap | not_captured",
        "source_gap_issue": null
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
    populated (newtron#12 has shipped, or a future verbose-mode
    surface), and the classification follows from the call-site.
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
  `substrate.source_status`** is bounded:
  - `"available"` — `PerWrite.source` is populated; the section
    renders the call-site and function name.
  - `"pending_newtron_gap"` — `PerWrite.source` is null because
    [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)
    has not yet shipped. The section renders a brief note
    ("call-site provenance is pending newtron-side verbose-mode
    support; tracked at newtron#12") and the `source_gap_issue`
    field points to the gap. The body is still useful — the
    automation team can find the call-site by other means (grep
    on the substrate `(table, key)` for the emitting function);
    the report just does not auto-populate the name.
  - `"not_captured"` — `PerWrite.source` is null for some
    operation-specific reason (e.g., the operation was captured
    before newtron-server verbose mode was enabled, or the
    operator's deployment runs newtron without verbose mode).
    The section renders a note explaining this.
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
- Unknown or evicted `operation_id` → 400 with
  `kind: "precondition_failure"` per §Error Schema, with
  `details.condition: "operation_unknown_or_expired"`. Operations
  retention semantics are tracked at
  [newtcon#18](https://github.com/aldrin-isaac/newtcon/issues/18).
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
   `manual_equivalent.newtron_http.status` as one of the four
   bounded values. The typical answer is `not_applicable`
   (bug-report authorship is a newtcon presentation concern,
   not a newtron substrate operation) — but the rationale
   field names the operator's-tools alternative: read
   `GET /api/operations/{operation_id}` and author the body
   by hand against the external system. Operator-philosophy
   invariant #2 is binding: the operator can do this without
   newtcon.
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
