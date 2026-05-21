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
`/api/operations/{operation_id}` for verification completion (endpoint
defined when Inbox surface lands).

A stale `preview_id` (expired or already consumed) → 410 Gone with
`kind: "precondition_failure"`.

## Endpoints — Operator Inbox (second surface)

**Status:** stub. Detailed contract added when surface enters scope.

Planned endpoints:
- `GET /api/inbox` — list of inbox cards (drift, convergence stragglers,
  partial operations, reference-count warnings, reconcile-due signals).
- `GET /api/inbox/{card_id}` — full detail for one card.
- `POST /api/inbox/{card_id}/dismiss` — operator dismissal with reason.
- `POST /api/inbox/{card_id}/action` — execute the card's primary action.
- `GET /api/operations/{operation_id}` — pipeline trace for an in-flight or
  recently completed operation.

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
