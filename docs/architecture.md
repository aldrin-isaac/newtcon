# newtcon Architecture

newtcon ships **two artifacts** that compose into one operator-facing
console: a smaller observation-side Go HTTP service (`newtcon-server`)
and a browser frontend that delivers the three operator workflows
(Composer / Inbox / Workbench) by composing two backends —
`newtrun-server` for orchestration substrate and `newtcon-server` for
observation history, report bug, provenance, and teaching catalogs.

The substrate boundary is set by
[`docs/adr/0001-scope-justification-vs-newtrun.md`](adr/0001-scope-justification-vs-newtrun.md)
(Status: Accepted, 2026-05-28). This document describes the
post-rebalance shape: what `newtcon-server` owns, what it consumes
from `newtrun-server` and `newtron-server`, and where the
operator-facing workflows live.

For binding rules, see [`../CLAUDE.md`](../CLAUDE.md). For API
definitions, see [`../API_CONTRACT.md`](../API_CONTRACT.md). For team
structure, see [`../AGENTS.md`](../AGENTS.md). For the substrate
analysis that justifies the partition, see
[`docs/adr/0001-scope-justification-vs-newtrun.md`](adr/0001-scope-justification-vs-newtrun.md).

## The two artifacts

### Artifact 1 — `newtcon-server` (Go HTTP service)

`newtcon-server` is the substrate `newtcon` uniquely owns per ADR-0001
§"What stays in newtcon." Four layers, each surfacing one operator
concern, all served from one process:

1. **Observation History** — the SQLite polling store with adaptive
   per-Node polling, `change_id` / `observation_id` /
   `observation_gap` markers, and the
   `source: newtron_mediated | out_of_band` discrimination engine.
   This is the load-bearing reason `newtcon-server` exists per
   ADR-0001 §Bucket B.1.
2. **Report Bug** — substrate-canonical bug-report body composition
   with `clipboard` / `direct_file` delivery modes. Depends on
   Observation History for recent-context blocks and on `newtcon-server`'s
   operations store (populated by observing `newtrun-server`'s run
   state) for operation-trace blocks.
3. **Provenance** (sharpening deferred) — read-only substrate
   inspection: intents, projection, changesets, verify assertions. Per
   the ADR-0001 borderline-bucket framing, the final implementation
   shape (full handlers vs thin proxy in front of `newtron-server`)
   sharpens as the Observation History layer matures. The operator-facing
   contract is unchanged across the deferral.
4. **Teaching catalogs** — Manual-Mode Parity and Rehearsal. Static,
   author-curated markdown / structured content addressable by ID.

Two cross-cutting components support the four layers:

- **Operations store** — newtcon-server's long-lived per-operation
  history (per ADR-0001 §"What stays in newtcon," the substrate that
  makes `operation_url` valid across time and that the Observation
  History correlation engine writes against). Populated by observing
  `newtrun-server`'s run state per `API_CONTRACT.md` §Operations
  capture-path.
- **`/api/health`** — liveness probe with the `operations_retention`
  companion so the operator never has to guess the deployment's
  retention floors.

### Artifact 2 — the browser frontend

The browser frontend is the load-bearing operator experience. It
delivers the three operator workflows by composing two HTTP backends.

- **Service Composer** — pick a service spec, pick N target interfaces
  across M nodes, preview the resulting ChangeSets, commit. Delivered
  by the frontend over `newtrun-server`'s `POST /api/runs/inline`
  (newtron#23, landed 2026-05-29) and `GET /api/runs/{suite}/events`
  SSE (newtron#22, landed 2026-05-29) carrying `EventStepProgress`
  with verbatim `sonic.DeviceOp` per newtron's §46 wire-shape
  principle (newtron#24, landed 2026-05-29).
- **Operator Inbox** — actionable cards for drift, convergence
  stragglers, partial operations, reference-count warnings,
  reconcile-due signals. Delivered by the frontend composing
  `newtrun-server`'s run history with `newtcon-server`'s Observation
  History.
- **Change Workbench** — staged batches of intents with dry-run
  preview, commit, stash, and revert. Delivered by the frontend over
  `newtrun-server`'s scenario substrate. Scenario CRUD is in flight
  upstream as newtron#33.

The browser frontend also surfaces `newtcon-server`'s Observation
History, Provenance, Report Bug, and Teaching Catalogs alongside the
three operator workflows. The operator opens **one tool**; the
frontend composes two backends and surfaces a single integrated
console.

The frontend is load-bearing for the operator workflows in the
post-rebalance architecture; it is not optional v0 content. The
framework selection is recorded as
[ADR-0002](adr/0002-frontend-framework.md) (pending — the first
frontend slice authors it).

## Layering

The post-rebalance pipeline, with the substrate boundaries set by the
two HTTP-spoken backends:

```
                            Browser frontend (static assets in web/)
                                    │
                ┌───────────────────┴────────────────────┐
                │                                        │
                │ (HTTP, JSON — newtcon-server contract) │ (HTTP, JSON + SSE — newtrun-server contract)
                ▼                                        ▼
       newtcon-server                              newtrun-server
       (this repo, Go)                             (newtron repo)
                │
       internal/server          ← routing, middleware, request lifecycle
                │
       internal/handlers        ← per-endpoint logic for the four newtcon-server layers
                │
       ┌────────┼──────────────┐
       ▼        ▼              ▼
   internal/  internal/    internal/
   newtronc   newtrunc      history
       │        │              │
       │        │              │ (SQLite, per CLAUDE.md §No Hidden State carve-out)
       │        │              ▼
       │        │         observation-history store
       │        │         + operations store
       │        │
       │ (HTTP) │ (HTTP, JSON + SSE)
       ▼        ▼
   newtron-server   newtrun-server
   (per-device)     (orchestration)
```

The `internal/types` package owns the API DTOs for `newtcon-server`'s
outward contract and is consumed by every layer. It is omitted from
the diagram for visual clarity but sits alongside `internal/server`
in the dependency graph.

Each layer's responsibility is bounded:

- **`internal/server`** owns HTTP concerns for `newtcon-server`'s
  outward surface: routing, middleware (logging, recovery, request
  ID), method/path/content-type validation. It never speaks to
  `newtron-server` or `newtrun-server` and never knows what a
  ChangeSet is.

- **`internal/handlers`** owns API contract concerns: parsing typed
  requests, validating contract-level constraints, calling
  `internal/newtronc` / `internal/newtrunc` / `internal/history`, and
  shaping the response per [`../API_CONTRACT.md`](../API_CONTRACT.md).
  One handler file per resource family (see
  [`../CLAUDE.md`](../CLAUDE.md) §File Ownership Map).

- **`internal/newtronc`** owns `newtron-server` integration. It is
  the only package that makes HTTP requests to `newtron-server`. It
  is the substrate path for the Provenance layer's per-Node
  projection reads, the Observation History layer's per-Node CONFIG_DB
  polling, and any other newtcon-server surface that needs
  per-device substrate.

- **`internal/newtrunc`** owns `newtrun-server` integration. It is
  the only package that makes HTTP requests to `newtrun-server`. It
  is the substrate path for the operations store's capture loop —
  `newtcon-server` subscribes to `GET /api/runs/{suite}/events` (SSE
  per newtron#22) for in-flight operations and polls
  `GET /api/runs/{suite}` for terminal-state reconciliation, writing
  each observed operation's pipeline trace + verify assertion into
  the operations store per `API_CONTRACT.md` §Operations
  capture-path.

- **`internal/history`** owns the persistent observation-history
  substrate. SQLite-backed, single-process, transactional. Holds two
  related stores: the polling layer's per-Node snapshots + diffs +
  `observation_gap` markers, and the operations store's per-operation
  pipeline traces + verify assertions + correlation metadata. Both
  stores share the same SQLite file because the source-classification
  engine (`newtron_mediated` vs `out_of_band`) correlates across them
  in tight loops. This is the only persistent state newtcon-server
  carries, per [`../CLAUDE.md`](../CLAUDE.md) §No Hidden State.

- **`internal/types`** owns API DTOs — request and response shapes
  for `newtcon-server`'s outward API. These are `newtcon-server`'s
  own types, defined to match the contract. They are translated to
  and from `newtron-server`'s response shapes inside
  `internal/newtronc` and from `newtrun-server`'s response shapes
  inside `internal/newtrunc`. The three type families
  (`newtcon-server` outward, `newtron-server` upstream,
  `newtrun-server` upstream) must not be conflated.

- **`web/`** owns the browser frontend. The frontend consumes both
  `newtcon-server`'s HTTP API and `newtrun-server`'s HTTP API
  directly. It does not route through `newtcon-server` to reach
  `newtrun-server`; the composition is browser-side. The framework
  selection is recorded as [ADR-0002](adr/0002-frontend-framework.md)
  (pending — authored by the first frontend slice).

## Why three separate processes

`newtcon-server`, `newtron-server`, and `newtrun-server` run as
three independent processes communicating over HTTP. They could in
principle be co-deployed, or `newtcon-server` could import the others
as Go libraries. None of that happens, for the same three reasons
that justified the original `newtcon-server` ↔ `newtron-server`
separation, applied symmetrically to the new
`newtcon-server` ↔ `newtrun-server` boundary that ADR-0001 introduced:

1. **Blast-radius cap.** Agents working on `newtcon-server` do not
   have `newtron-server` source or `newtrun-server` source in their
   dependency graph at all — no `go.mod` entries, no vendored code.
   Each boundary is a network address, not a directory convention.

2. **HTTP API as contract.** `newtron-server`'s HTTP API is already
   the contract that `bin/newtron` consumes. `newtrun-server`'s HTTP
   API is already the contract that the browser frontend consumes for
   the three operator workflows. `newtcon-server` being a separate
   client of both forces both upstreams to keep their HTTP surfaces
   stable. Anything `newtcon-server` needs that an upstream does not
   expose becomes a deliberate, reviewable upstream change per
   [`../CLAUDE.md`](../CLAUDE.md) §Gap-Handling Protocol.

3. **Operational independence.** All three processes can be
   restarted, rolled back, or upgraded independently.
   `newtron-server` manages device-facing concerns; `newtrun-server`
   manages orchestration concerns; `newtcon-server` manages
   operator-facing observation concerns. A bug in one does not take
   down the other two.

A consequence: `newtcon-server` could be reimplemented in any
language that speaks HTTP. Go is the current choice for type-checking
and ecosystem fit, but the boundary is correct independent of that
choice. This is the cleanest signal that the architecture is right —
when the technology choice is not load-bearing on the boundary, the
boundary is structural. The same property holds for both upstream
boundaries: the browser frontend could itself be reimplemented in any
framework that speaks HTTP, and the composition would still be
correct.

## Non-Goals

These are not in `newtcon` and will not be added. If a contributor
(human or agent) proposes them, the PR is rejected on principle.

### Non-goals introduced or sharpened by the rebalance

- **`newtcon-server` does not initiate state-changing operator
  workflows.** Per ADR-0001 §Bucket A, the Composer / Inbox /
  Workbench state-changing surfaces moved to `newtrun-server`.
  `newtcon-server` observes the operations they produce (capturing
  them into the operations store per `API_CONTRACT.md` §Operations
  capture-path) but does not author them. A contributor proposing a
  state-changing endpoint on `newtcon-server` that re-implements an
  orchestration capability `newtrun-server` already exposes is making
  the case for re-introducing the duplicative substrate ADR-0001
  retired; the Architecture Reviewer rejects on principle.

- **`newtcon-server` does not maintain its own orchestration
  substrate.** Scenario authoring, run state, step-progress
  streaming, run lifecycle, and per-target/per-Node atomicity
  enforcement are `newtrun-server`'s substrate per ADR-0001. The
  per-Node atomicity model the three operator workflows surface is
  preserved through the substrate chain (`newtrun-server` mediates
  `newtron-server`'s `cs.Apply`, which uses Redis `TxPipeline`); it
  is not enforced or duplicated at the `newtcon-server` layer.

- **`newtcon-server` does not stream Server-Sent Events.** Per
  `API_CONTRACT.md` §Conventions post-rebalance, no surviving
  `newtcon-server` endpoint admits SSE. The SSE substrate for
  state-changing operator workflows is `newtrun-server`'s
  `GET /api/runs/{suite}/events` per newtron#22.
  `newtcon-server` consumes that SSE in `internal/newtrunc` to
  populate the operations store, but does not re-emit it.

- **Bypassing `newtrun-server`'s orchestration.** The browser
  frontend does not call `newtron-server` directly for the three
  operator workflows; it composes through `newtrun-server`. Operator
  workflows that reach into `newtron-server` past `newtrun-server` —
  e.g., a "raw newtron call" surface — re-introduce the bypass
  pattern ADR-0001 retired.

### Non-goals preserved from the pre-rebalance architecture

These predate the rebalance and remain binding. Per
[`../CLAUDE.md`](../CLAUDE.md) §Project Scope §Out of scope:

- **Drag-and-drop blueprint editor.** The Apstra paradigm. Operators
  do not design networks in `newtcon`. Read-mostly topology
  visualization is *future-considered*, not out of scope; see the
  [roadmap](roadmap.md). The rejected paradigm is the canvas, not the
  topology lifecycle. Topology spec edits — when they land — route
  through `newtrun-server`'s scenario substrate, mediated by
  `newtron-server`'s typed verbs, like every other operator-initiated
  spec change.

- **Per-device form configurator.** The Apstra "click on switch, fill
  out CONFIG_DB form, submit" workflow. The service is the unit of
  operator action.

- **Multi-batch / history-walking rollback.** No "undo the last N
  committed batches in one call" surface, because no substrate primitive
  exists upstream for it. Per-batch revert exists in the Change
  Workbench workflow (delivered by the browser frontend over
  `newtrun-server`), and is per-Node atomic; multi-batch undo is
  operator-orchestrated as a sequence of revert calls, per
  [`../CLAUDE.md`](../CLAUDE.md) §Project Scope.

- **Preview-time multi-target apply safety classification.** No
  `classification` field on preview responses, no plan to add one.
  The operator's affordance for partial-failure awareness is runtime
  substrate visibility — `EventStepProgress` events carrying verbatim
  `sonic.DeviceOp` substrate, per-target results with per-write
  granularity, typed verify-failure envelopes — observed through
  `newtrun-server`'s SSE and through `newtcon-server`'s operations
  store.

- **Status dashboard as primary surface.** Status surfaces exist
  (inside inbox cards, inside operation traces), but they are not the
  landing page. The operator lands on actionable work, not on
  green/red lights.

- **Authentication/authorization.** Deferred. The operator surfaces
  are validated against the substrate first; auth lands once they are
  stable. Both `newtcon-server` and `newtrun-server` defer auth
  symmetrically; the boundary between them is loopback by default
  (`127.0.0.1`-bound), and non-loopback exposure requires explicit
  configuration with a startup banner acknowledging no built-in auth
  (per newtron#22's bind-listen policy).

- **Multi-user collaboration / activity feeds.** Deferred
  indefinitely. `newtcon` serves the operator persona as a power
  tool; collaboration features are not part of that persona.

- **Mobile-first UI.** `newtcon` is desktop-grade. No responsive
  design effort for small viewports.

- **Bypassing the HTTP boundary into upstream Go packages.**
  `newtcon-server` never imports `newtron` or `newtrun` Go packages,
  never invokes upstream CLIs as subprocesses, never reads CONFIG_DB
  via a Redis client. All upstream interaction is HTTP, through
  `internal/newtronc/` (for `newtron-server`) or
  `internal/newtrunc/` (for `newtrun-server`).

## Surfaces and substrate paths

The four `newtcon-server` layers and the three browser-frontend
operator workflows compose into one operator experience. Each surface
has a defined substrate path: which backend it consumes, where the
substrate originates, what the operator sees.

### Operator workflows (browser frontend over `newtrun-server`)

The three operator workflows — Service Composer, Operator Inbox,
Change Workbench — are delivered by the browser frontend over
`newtrun-server`. The substrate path is:

```
Operator → browser frontend → newtrun-server → newtron-server → device
                                    │                  │
                                    │                  └─ cs.Apply / ApplyDrift / ReplaceAll
                                    │                     (per-Node atomic via Redis TxPipeline)
                                    │
                                    └─ EventStepProgress events
                                       (SSE per GET /api/runs/{suite}/events)
                                       carrying verbatim sonic.DeviceOp substrate

newtcon-server observes those events via internal/newtrunc and writes
each observed operation's pipeline trace + verify assertion into the
operations store (substrate for the §Operations contract surface).
```

The Operator Inbox additionally composes `newtrun-server`'s run state
(for `partial_operation` and `convergence_straggler` cards) with
`newtcon-server`'s Observation History (for `drift` cards, derived
from the per-Node CONFIG_DB diff). The browser frontend issues the
composition; no `newtcon-server` endpoint mediates it.

The Change Workbench's staging substrate is `newtrun-server`'s
scenario YAML. Scenario CRUD (`POST /api/suites`, `PUT/DELETE` on
scenarios) is in flight upstream as newtron#33; until that lands, the
browser frontend's Workbench is read-only against existing scenarios.

### `newtcon-server`-owned surfaces

The four observation-side surfaces — Observation History, Report Bug,
Provenance, Teaching catalogs — are delivered by `newtcon-server`
directly. The browser frontend consumes each as one HTTP backend in
its two-backend composition.

- **Observation History** is the polling layer's substrate output.
  The polling loop runs inside `newtcon-server`, calls
  `internal/newtronc` to read per-Node CONFIG_DB at adaptive cadence,
  writes snapshots and diffs into `internal/history`, and surfaces
  them through the `/api/history/...` endpoint family. The
  source-classification engine
  (`newtron_mediated` vs `out_of_band`) correlates each observed diff
  against the operations store (also in `internal/history`).

- **Report Bug** composes substrate from three sources: the
  operations store (for operation-trace blocks), the Observation
  History store (for recent-context blocks), and `newtron-server`
  via `internal/newtronc` (for intent record and projection blocks).
  The composition produces a substrate-canonical Markdown body the
  operator reviews before confirming delivery to clipboard or a
  configured integration target.

- **Provenance** reads `newtron-server` substrate (intents,
  projection, changesets, verify) via `internal/newtronc` and
  surfaces it with navigation-link companions and cross-reference
  fields. The implementation may sharpen to a thin proxy as the
  Observation History layer matures (per the ADR-0001 borderline-bucket
  framing); the operator-facing contract is unchanged.

- **Teaching catalogs** (Manual-Mode Parity and Rehearsal) are
  static, author-curated content addressable by ID. Served as
  rendered JSON from `newtcon-server`; could equivalently be served
  by any static-file HTTP server. Rides along with `newtcon-server`
  for deployment convenience.

## Caching and persistent state

`newtcon-server`'s persistent state is limited to its
`internal/history` substrate — observation-history snapshots and
diffs, and the operations store's per-operation pipeline traces. Both
substrates are stored in SQLite, single-process, transactional.

Operational substrate (live intent, live projection, live ChangeSet,
live drift detection) is **never cached persistently**. It is sourced
live from `newtron-server` at query time. Per-request, the server may
cache within a handler call to avoid duplicate HTTP calls to
`newtron-server`. Any cache beyond that requires a contract decision
(Architect PR) and must be explicit, time-bounded, invalidatable, and
surfaced with `as_of` timestamps in the response.

`newtrun-server` run state is **not** cached on `newtcon-server`; the
operations store records observations of run state at the
`EventStepProgress` event level, but live run state for in-flight
runs is read from `newtrun-server` at query time when the operator
asks for it.

Hidden caches violate [`../CLAUDE.md`](../CLAUDE.md) §No Hidden State.

## File ownership map

The repository layout. Every feature lives in one file; a reader must
be able to guess where something is implemented from the file tree
alone. See [`../CLAUDE.md`](../CLAUDE.md) §File Ownership Map for the
binding statement; this section documents the structure the binding
rule maps onto.

```
cmd/newtcon-server/main.go      → process entry, flag parsing, server boot
                                   (--newtron-url, --newtrun-url, --listen, etc.)

internal/server/                → HTTP routing, middleware, request lifecycle
  router.go                     → route registration for the surviving newtcon-server contract
  middleware.go                 → logging, recovery, request ID

internal/handlers/              → one file per resource family (surviving newtcon-server contract)
  health.go                     → /api/health (operations_retention companion)
  operations.go                 → /api/operations/* (operations store reads)
  provenance.go                 → /api/intents/*, /api/projection/*, /api/changesets/*
  manual.go                     → /api/manual/* (Manual-Mode Parity teach surface, static catalog)
  rehearsal.go                  → /api/rehearsal/* (Rehearsal teach surface, static catalog)
  history.go                    → /api/history/* (Observation History reads)
  report_bug.go                 → /api/report-bug/* (compose-and-deliver)

internal/newtronc/              → the ONLY HTTP client of newtron-server
  client.go                     → HTTP client, base URL config, retry/timeout policy
  intents.go                    → intent / projection / changeset / verify reads
  config_db.go                  → per-Node CONFIG_DB reads for the polling layer

internal/newtrunc/              → the ONLY HTTP client of newtrun-server
  client.go                     → HTTP client, base URL config, retry/timeout policy
  runs.go                       → /api/runs read surface + EventStepProgress SSE subscription
  topologies_suites.go          → /api/topologies, /api/suites listing reads

internal/history/               → SQLite-backed persistent substrate
  schema.go                     → table definitions for both stores
  snapshots.go                  → per-Node observation snapshots
  diffs.go                      → observation-history diff records + observation_gap markers
  operations.go                 → operations store: pipeline traces + verify assertions
  classification.go             → source-classification engine (newtron_mediated vs out_of_band)
  poller.go                     → adaptive per-Node polling loop driving the snapshots
  capture.go                    → newtrun-run-state capture loop (consumes internal/newtrunc SSE)

internal/types/                 → API DTOs (request/response shapes for the contract)
  health.go                     → HealthResponse, OperationsRetention
  operations.go                 → OperationsResponse, PipelineTrace, VerifyAssertion
  provenance.go                 → IntentRecord, Projection, ChangeSet, VerifyAssertion
  manual.go                     → TeachResponse, Scenario, CautionNote
  rehearsal.go                  → Walkthrough, WalkthroughStep, LabDeviceGuidance
  history.go                    → ChangeRecord, Snapshot, ObservationGap
  report_bug.go                 → ReportBugPreview, BodySection, DeliveryOption
  shared.go                     → ChangeSet, Validate, Confidence, Reverses, PerWrite,
                                   manual_equivalent.newtron_http
                                   (per API_CONTRACT.md §Shared substrate shapes)

web/                            → browser frontend
  (framework selected by ADR-0002; the first frontend slice authors that ADR)
  src/                          → application source
  src/api/newtcon/              → typed client of newtcon-server's HTTP API
  src/api/newtrun/              → typed client of newtrun-server's HTTP API
  src/workflows/                → Composer, Inbox, Workbench composition logic
  src/surfaces/                 → Observation History, Provenance, Report Bug,
                                   Teaching catalogs (newtcon-server-backed views)
  src/design-system/            → typography, color, motion, component vocabulary
                                   (authored per the Architect's design-system ADRs)
  dist/                         → built static assets served by newtcon-server

docs/                           → architecture, ADRs, audits, operator-philosophy
```

When adding new endpoints, find the existing handler file by resource
family; do not create new handler files unless adding a new resource
family. When adding new HTTP-client surface, route through the
appropriate `internal/newtronc/` or `internal/newtrunc/` package; CI
enforces that no other package constructs HTTP traffic to either
upstream.

### `internal/newtronc/` and `internal/newtrunc/` symmetry

The two upstream-client packages mirror each other structurally and
are bound by the same isolation rules:

- Each is the **only** HTTP client of its respective upstream in
  `newtcon-server`. CI enforces this isolation: no other package may
  construct an `http.Client` or call `http.Get` / `http.Post` against
  either upstream's address.
- Each translates between `newtcon-server`'s own DTOs (in
  `internal/types`) and the upstream's HTTP response shapes. The two
  type families must not be conflated; the translation lives inside
  the client package.
- Each is configured by a single `--<upstream>-url` flag
  (`--newtron-url`, `--newtrun-url`), defaulting to `127.0.0.1` ports.
  Non-loopback exposure on the upstream side is the upstream's
  configuration concern; `newtcon-server` simply consumes the
  resolved URL.

The symmetry is structural, not coincidental. ADR-0001 introduced
the `newtcon-server` ↔ `newtrun-server` boundary as a second peer of
the original `newtcon-server` ↔ `newtron-server` boundary, with the
same operational independence, blast-radius cap, and HTTP-as-contract
properties.

### `internal/history/` — the persistent-substrate package

`internal/history/` is the only package in `newtcon-server` that
persists state across requests. It backs two related stores in the
same SQLite database:

- **Observation-history store** — per-Node snapshots of CONFIG_DB,
  diffs between adjacent snapshots, and `observation_gap` markers for
  any window where polling missed updates. Populated by `poller.go`'s
  adaptive per-Node polling loop, which reads through
  `internal/newtronc/`.
- **Operations store** — per-operation pipeline traces + verify
  assertions + initiator metadata. Populated by `capture.go`'s
  newtrun-run-state capture loop, which subscribes to
  `internal/newtrunc/`'s `EventStepProgress` SSE for in-flight
  operations and polls `internal/newtrunc/`'s
  `GET /api/runs/{suite}` for terminal-state reconciliation.

The two stores share a SQLite file because the
source-classification engine in `classification.go` correlates across
them in tight loops: every observed diff in the observation-history
store is checked against the operations store for a
`newtron_mediated` correlation (the operator-mediated changes the
operations store records) and falls back to `out_of_band` when no
correlation is found.

The choice of SQLite is the operator's per
[newtcon#37](https://github.com/aldrin-isaac/newtcon/issues/37) (the
v0 storage decision). The contract surface in
[`../API_CONTRACT.md`](../API_CONTRACT.md) is storage-agnostic;
migration to a different store (timeseries DB, embedded KV) is
non-contract-breaking provided the response shapes and retention
guarantees are preserved.

## Frontend framework selection

Resolved by [ADR-0002](adr/0002-frontend-framework.md) (Status:
Accepted, 2026-05-29): **vanilla HTML + TypeScript-as-typed-ES-
modules**, no SPA framework, no client-side framework runtime, no
bundler. `tsc` is the only build dependency; output is plain ES
modules served as static files by `newtcon-server`. See the ADR for
the four-criteria evaluation (bundle size, TypeScript first-class,
component model fit, two-backend composition), the considered
alternatives (vanilla-without-TypeScript, HTMX, Svelte/SvelteKit,
React + Vite, Solid), and the operator-philosophy + newtron-principles
defenses.
