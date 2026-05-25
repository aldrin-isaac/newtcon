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

`intent_id` is opaque — used only as a handle for subsequent operations.

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
      "pipeline": {
        "intent": { "stage": "complete", "at": "..." },
        "replay": { "stage": "complete", "at": "..." },
        "render": { "stage": "complete", "at": "..." },
        "deliver": { "stage": "complete", "at": "..." },
        "verify": { "stage": "in_progress" }
      }
    }
  ],
  "aggregate": {
    "all_applied": true,
    "verify_pending": 1
  }
}
```

The `verify` stage may complete after the response returns; consumers poll
[`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id) for
verification completion.

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
    "rationale_ref": "unified-pipeline-architecture.md#delta-reconcile"
  }
}

// kind: "convergence_straggler"
{
  "operation_id": "<opaque>",
  "pipeline": { /* same shape as GET /api/operations/{operation_id}.pipeline */ },
  "intent": {
    "kind": "ApplyService",
    "resource": "Ethernet0",
    "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
    "intent_id": "<opaque>"
  },
  "verify_assertion_diff": [
    { "table": "BGP_NEIGHBOR", "key": "default|10.1.0.1", "field": "asn", "expected": "65002", "actual": "" }
  ]
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
  "recommended_mode_rationale": "no drift detected; delta is sufficient (unified-pipeline-architecture.md#delta-reconcile)"
}
```

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
| `clear_zombie` | `{ "confirm_manual_cleanup": true }` (operator asserts CONFIG_DB has been cleaned by hand) |
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
    "after": { "missing": 0, "extra": 0, "modified": 0 }
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
    "estimated_data_plane_impact": "service-affecting"
  },
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 intent reconcile -x --mode delta",
    "newtron_http": {
      "method": "POST",
      "path": "/network/default/node/switch1/reconcile?dry_run=false",
      "body": { "mode": "delta" }
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
- `manual_equivalent` is REQUIRED on every action preview, including
  no-op verbs. It surfaces the exact newtron CLI and HTTP call the
  operator could issue by hand to achieve the same effect — the
  operator-philosophy invariant #2 (manual-mode parity) is binding,
  not aspirational.
- `disruption.estimated_data_plane_impact` is one of `"none"`,
  `"control-plane-only"`, `"service-affecting"`, `"network-affecting"`.
  newtcon derives this from the verb + reconcile mode + service
  reference graph; the derivation rules belong in
  `internal/newtronc/` and are an implementation concern.

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
    "intent":  { "stage": "complete",    "at": "2026-05-25T14:06:01Z" },
    "replay":  { "stage": "complete",    "at": "2026-05-25T14:06:01Z" },
    "render":  { "stage": "complete",    "at": "2026-05-25T14:06:01Z" },
    "deliver": { "stage": "complete",    "at": "2026-05-25T14:06:02Z" },
    "verify":  { "stage": "in_progress", "at": null }
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
`recheck`), `operation_id`, `operation_url`, and `pipeline` are omitted.

A stale `preview_id` → 410 Gone with `kind: "precondition_failure"`.

A drift-guard refusal at execution time (the device drifted between
preview and action) → 409 with `kind: "drift_refusal"`; the operator
must re-preview.

A newtron failure mid-pipeline → 502 with `kind: "internal"` and
`details` carrying the partial pipeline trace and the newtron error.

## Endpoints — Operations

These endpoints expose the per-operation pipeline trace used by Service
Composer apply, Inbox card actions, and (later) Change Workbench commit.
The trace shape is the same regardless of which surface initiated the
operation — the pipeline is one pipeline
(`unified-pipeline-architecture.md` §2).

### `GET /api/operations/{operation_id}`

Return the full per-stage pipeline trace for an in-flight or recently
completed operation. Idempotent; safe to poll. No newtron-side state is
mutated.

Operations are retained for at least 30 minutes after the terminal stage
reaches `complete` or `failed`. Beyond that retention, the operation may
return 404; consumers that need long-term records consult newtron's
intent history directly via newtcon's (future) Provenance surface.

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
    "intent_id": "<opaque>"
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
    },
    "verify": {
      "stage": "complete | in_progress | failed | skipped",
      "started_at": "2026-05-25T14:06:02Z",
      "completed_at": "2026-05-25T14:06:03Z",
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

- Every stage object has `stage` ∈ `pending | in_progress | complete | failed | skipped`.
  `pending` stages have null timestamps.
- `verify.assertion` is present only when `verify.stage == "complete"` or
  `verify.stage == "failed"`. The shape mirrors newtron's
  `VerificationResult` (`api.md` §15 Write Result Types): `passed`,
  `failed`, `errors[]`. `errors[]` is absent when all entries passed.
  This is `DESIGN_PRINCIPLES_NEWTRON` §14: verify is an assertion against
  the ChangeSet, not an observation.
- `intent.intent_record` exposes the NEWTRON_INTENT record that the
  operation wrote, in the same shape newtron stores it. Per
  `DESIGN_PRINCIPLES_NEWTRON` §1 and §22, the intent record IS the
  decision substrate; the operator must be able to read it directly,
  not via a digest.
- `terminal.outcome == "partial"` is reserved for multi-target operations
  initiated by Composer or Workbench; per-node operation traces use
  `success` or `failure` only.
- A stage that newtron does not execute for this verb is `skipped`, with
  `summary` carrying the reason (e.g., `acknowledge` verbs reach this
  endpoint via the `verb: "Reconcile"` family with `verify: skipped`
  only when the underlying newtron call explicitly skipped verify).

**Errors:**
- Unknown or expired `operation_id` → 404 with
  `kind: "precondition_failure"` and `details.reason: "operation_unknown_or_expired"`.
- newtron-server unreachable while the operation is still in-flight →
  503 with `kind: "newtron_unavailable"`; the last-known pipeline state
  is included in `details.last_known`.

## Endpoints — Change Workbench (third surface)

**Status:** stub. Detailed contract added when surface enters scope.

Planned endpoints:
- `POST /api/workbench/stage` — create or append to a staged batch.
- `GET /api/workbench/{batch_id}/status` — per-target status, ChangeSets,
  reference impact.
- `GET /api/workbench/{batch_id}/diff` — projection-before vs projection-after.
- `POST /api/workbench/{batch_id}/dry_run` — full sandbox replay.
- `POST /api/workbench/{batch_id}/commit` — atomic apply.
- `POST /api/workbench/{batch_id}/stash` — save for later.
- `POST /api/workbench/{batch_id}/revert` — reverse via recorded reverse ops.
