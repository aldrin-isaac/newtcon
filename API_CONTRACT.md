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

- All requests and responses are JSON (`Content-Type: application/json`).
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

**Request:**
```json
{
  "preview_id": "<from POST /api/preview>"
}
```

**Response 200:**
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
      }
    }
  ],
  "aggregate": {
    "all_applied": true,
    "verify_pending": 1
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

A stale `preview_id` (expired or already consumed) → 410 Gone with
`kind: "precondition_failure"`.

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

**Request:**
```json
{ "preview_id": "<from /action/preview>" }
```

**Response 200:**
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

For verbs that produce no ChangeSet (`acknowledge`, `clear_zombie`,
`recheck`), `operation_id`, `operation_url`, `pipeline`, and `verify` are
omitted.

A stale `preview_id` → 410 Gone with `kind: "precondition_failure"`.

A drift-guard refusal at execution time (the device drifted between
preview and action) → 409 with `kind: "drift_refusal"` per the typed
schema in §Error Schema; the operator must re-preview.

A newtron failure mid-pipeline → 502 with `kind: "internal"` per the
typed schema in §Error Schema. `details.partial_results` carries the
partial per-target results completed before the failure (matching the
shape of this endpoint's `per_target[]` success body); the
newtron-side error that triggered the catastrophic failure is logged
against `details.correlation_id`, not surfaced inline — the operator
quotes the correlation ID when filing the ops ticket. (When the
mid-pipeline failure CAN be attributed to a substrate cause, the
correct kind is `validation_failure`, `drift_refusal`, or
`newtron_unavailable`, not `internal`; `internal` is the residual
category for unclassified failures.)

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

**Response 200:**
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
      "failure": null
    }
  ],
  "per_node_results": [
    {
      "node": "switch1",
      "status": "committed",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 3,
      "operation_ids": ["<opaque>"]
    },
    {
      "node": "switch2",
      "status": "not_attempted",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 1,
      "operation_ids": []
    }
  ],
  "aggregate": {
    "outcome": "all_committed | partial | none_committed",
    "node_count_committed": 1,
    "node_count_failed": 0,
    "node_count_not_attempted": 1,
    "verify_pending_targets": 3,
    "stop_on_first_failure_triggered": true
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
  `per_target[]`). The batch state is left at `committed` with the
  partial results; the operator decides recovery via revert. The
  `details.correlation_id` is the handle for the ops ticket.

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

