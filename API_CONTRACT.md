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
    "details": { /* kind-specific structured payload */ }
  }
}
```

`kind` values are bounded; new kinds are a Contract PR.

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

A drift-guard refusal on any target → 409 with `kind: "drift_refusal"` and
structured drift details. The preview is not committed.

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
      "status": "pending_newtron_gap",
      "gap_issue": "https://github.com/aldrin-isaac/newtron/issues/3",
      "expected_shape": {
        "method": "POST",
        "path": "/network/default/node/switch1/reconcile",
        "query": { "dry_run": "false" },
        "body": { "mode": "delta" }
      }
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
  | `reconcile_delta` | `pending_newtron_gap` | newtron#3 |
  | `reconcile_full` | `pending_newtron_gap` | newtron#3 (composite workflow available as a 3-call sequence but does not match newtcon's single-action contract; see gap issue) |
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
409 with `kind: "drift_refusal"` and `details` carrying the
`DriftEntry[]` returned by newtron.

A validation failure (the action would write invalid CONFIG_DB per
`DESIGN_PRINCIPLES_NEWTRON` §13) → 200 with `validate.ok == false` and
`validate.errors[]` populated; the preview is returned but
`produces_changeset` does not imply executable.

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
preview and action) → 409 with `kind: "drift_refusal"`; the operator
must re-preview.

A newtron failure mid-pipeline → 502 with `kind: "internal"` and
`details` carrying the partial pipeline trace and the newtron error.

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
  `kind: "precondition_failure"` and `details.reason: "operation_unknown_or_expired"`.
- newtron-server unreachable while the operation is still in-flight →
  503 with `kind: "newtron_unavailable"`; the last-known pipeline state
  is included in `details.last_known`.

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
- Unknown `batch_id` → 404 `precondition_failure`.
- newtron unreachable → 503 `newtron_unavailable` with
  `details.last_known.projection_diff` carrying the most recent
  successful diff if any.

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
"drift_refusal"` and `details.per_target[]` listing the
`DriftEntry[]` per affected Node. The preview is not returned.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure`.
- Batch state is `committed` or `reverted` (terminal mutating
  states) → 409 `precondition_failure` with `details.current_state`.
  Dry-run on a stashed batch is allowed (and useful — the operator
  inspects a stashed batch's effect before deciding to restore).
- newtron unreachable for any Node → 503 `newtron_unavailable` with
  `details.unreachable_nodes[]`. The dry-run is not partially
  returned; either every Node's sandbox replay succeeds or the call
  fails.

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
  `newtron_unavailable` with `details.unreachable_nodes[]`. The
  preview is not partially rendered.

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
    "kind": "validation_failure | drift_refusal | precondition_failure | newtron_internal",
    "message": "<newtron's domain-level error>",
    "details": { /* kind-specific substrate */ }
  }
  ```
  The `kind` values match newtron's substrate-level error
  classifications, NOT HTTP status codes (per `CLAUDE.md`
  §Operator-Honest Errors).
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
- `preview_id` was a dry-run preview, not a commit-preview → 400
  `validation_failure` with `details.preview_kind`. The contract
  rejects this on principle: the operator must have seen the
  substrate-faithful commit preview before committing.
- Batch state is not `previewed` (commit-preview must immediately
  precede commit) → 409 `precondition_failure`.
- Catastrophic newtcon-server failure mid-sequence → 502 with
  `kind: "internal"` and `details.partial_results.per_target[]`
  carrying the per-Node results completed before the failure. The
  batch state is left at `committed` with the partial results; the
  operator decides recovery via revert.

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
  `newtron_unavailable` with `details.unreachable_nodes[]`.

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
  `kind: "newtron_unavailable"` and `details.last_known.record`
  carrying the most recent cached record snapshot if newtcon-server
  has one from a prior fetch within the request-cache window.

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
        "manual_equivalent_newtron_cli": "newtron switch1 intent reconcile -x  # full; see gap #3 for delta"
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
  `kind: "newtron_unavailable"` and `details.last_known.assertion`
  carrying the most recent assertion snapshot newtcon-server has.


