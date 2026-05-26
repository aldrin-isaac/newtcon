# newtcon Architecture

newtcon is structured as a thin operator-UI layer on top of newtron's public
API. This document describes the layering, the boundaries, and the non-goals.
For binding rules, see [`../CLAUDE.md`](../CLAUDE.md). For API definitions,
see [`../API_CONTRACT.md`](../API_CONTRACT.md). For team structure, see
[`../AGENTS.md`](../AGENTS.md).

## Layering

newtcon is a pipeline, with newtron reached across the network rather than
across a Go module boundary:

```
Browser
    │  (HTTP, JSON — newtcon's outward API)
    ▼
internal/server          ← routing, middleware, request lifecycle
    │
    ▼
internal/handlers        ← per-endpoint logic, request validation, response shaping
    │  (Go types — newtcon DTOs from internal/types)
    ▼
internal/newtronc        ← the ONLY HTTP client of newtron-server
    │  (HTTP, JSON — newtron's HTTP API)
    ▼
newtron-server (separate process, separate repo)
    │
    ▼
newtron core             ← never reached from newtcon at any layer
```

Each layer's responsibility is bounded:

- **`internal/server`** owns HTTP concerns for newtcon's outward surface:
  routing, middleware (logging, recovery, request ID),
  method/path/content-type validation. It never speaks to newtron and never
  knows what a ChangeSet is.

- **`internal/handlers`** owns API contract concerns: parsing typed requests,
  validating contract-level constraints, calling `internal/newtronc`, shaping
  the response per [`../API_CONTRACT.md`](../API_CONTRACT.md). One handler
  file per resource family (see [`../CLAUDE.md`](../CLAUDE.md) §File Ownership
  Map).

- **`internal/newtronc`** owns newtron integration. It is the only package
  that makes HTTP requests to newtron-server. Handlers call into `newtronc`
  via Go function calls; `newtronc` translates those calls into HTTP requests
  against newtron-server's API. CI enforces that no other package constructs
  newtron-bound HTTP traffic.

- **`internal/types`** owns API DTOs — request and response shapes for
  newtcon's outward API. These are newtcon's own types, defined to match
  newtcon's contract. They are translated to and from newtron's HTTP response
  shapes inside `internal/newtronc`. The two type families must not be
  conflated.

- **`web/`** owns the frontend. Framework is selected at the first frontend
  slice (see [`../AGENTS.md`](../AGENTS.md) — the Architect chooses with input
  from the Tech Lead). The frontend consumes newtcon's HTTP API and nothing
  else; it never speaks to newtron-server directly.

## Why a Separate Process

newtcon and newtron run as separate processes communicating over HTTP. They
could in principle be co-deployed in a single binary, or newtcon could
import newtron as a Go library; neither happens, for three reasons:

1. **Blast-radius cap.** Agents working on newtcon do not have newtron source
   in their dependency graph at all — no `go.mod` entry, no vendored code,
   nothing. The boundary is a network address, not a directory convention or
   a Go import lint.

2. **HTTP API as contract.** newtron's HTTP API is already the contract that
   `bin/newtron` (the CLI) consumes. newtcon being another client of the
   same API forces newtron to keep its HTTP surface stable and complete —
   anything newtcon needs that newtron does not expose becomes a deliberate,
   reviewable change to newtron's HTTP surface.

3. **Operational independence.** newtron and newtcon can be restarted, rolled
   back, or upgraded independently. The newtron server manages device-facing
   concerns; newtcon manages operator-facing concerns. A bug in one does not
   take down the other.

A consequence: newtcon could be reimplemented in any language that speaks
HTTP. Go is the current choice for type-checking and ecosystem fit, but the
boundary is correct independent of that choice. This is the cleanest signal
that the architecture is right — when the technology choice is not load-bearing
on the boundary, the boundary is structural.

## Non-Goals

These are not in newtcon and will not be added. If a contributor (human or
agent) proposes them, the PR is rejected on principle:

- **Drag-and-drop blueprint editor.** newtcon does not present a
  free-form canvas where operators design networks by dragging
  devices and drawing links. That is the Apstra paradigm newtcon is
  built against. **The rejected paradigm is the canvas, not the
  topology lifecycle.** Topology is a network-scoped definition
  newtron owns (`../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md` §7);
  adding, removing, or rewiring devices via **typed verbs** (with
  substrate visibility, schema validation, and the
  manual-equivalent CLI shown) is legitimate operator work and a
  future-considered surface — see the **Spec authoring** entry in
  [`roadmap.md`](roadmap.md) (widened to include topology). Topology
  changes have infrastructure implications: in lab mode, newtlab
  re-deploys the affected device(s); in production, the operator
  performs the physical rack-and-cable step. newtcon's role across
  both modes is the same — mediate the spec edit through newtron's
  typed verbs and surface the substrate. **Read-mostly topology
  visualization** (a tier-centric concentric-ring view of the
  topology spec, with operator navigation drilling into existing
  operating surfaces) is also future-considered. The non-goal here
  is the canvas paradigm — not the topology lifecycle and not the
  visualization itself.

- **Per-device form configurator.** newtcon does not present a "click on
  switch, fill out CONFIG_DB form, submit" workflow. That is the Apstra
  paradigm and is what newtcon is built against. The service is the unit
  of operator action.

- **Status dashboard as primary surface.** Status surfaces exist (inside
  inbox cards, inside operation traces), but they are not the landing page.
  The operator lands on actionable work, not on green/red lights.

- **Authentication/authorization.** Deferred. The first three surfaces are
  validated against the substrate; auth lands once they are stable.

- **Multi-user collaboration / activity feeds.** Deferred indefinitely.
  newtcon serves the operator persona as a power tool; collaboration
  features are not part of that persona.

- **Mobile-first UI.** newtcon is desktop-grade. No responsive design effort
  for small viewports.

- **Bypassing newtron's API.** newtcon never reads CONFIG_DB directly, never
  calls newtron's CLI as a subprocess, never imports newtron Go packages,
  never copy-pastes newtron internal types. All newtron interaction is HTTP,
  through `internal/newtronc/`.

## Surfaces and Their Pipeline Trace

Each of the three operator surfaces produces operations that trace through
newtron's pipeline (Intent → Replay → Render → [Deliver]) and, when the
operation delivered to a device, the post-deliver Verify assertion. The UI
makes both the pipeline stages and the verify assertion visible — this is
non-negotiable per [`../CLAUDE.md`](../CLAUDE.md) §Pipeline-Aware UX.

The two are deliberately not collapsed into a single "five-stage pipeline."
Per `../newtron/docs/newtron/unified-pipeline-architecture.md` §2, the
pipeline is `Intent → Replay → Render → [Deliver]` — four stages, with
`Deliver` conditional on whether the caller commits the ChangeSet. Per §7
of the same document, `cs.Verify(n)` is a **Device I/O operation**: it
re-reads CONFIG_DB and asserts that what was delivered actually landed.
Verify is therefore a post-deliver assertion against the device, not a
sibling of the build stages. The contract (`../API_CONTRACT.md`
§Operations) reflects that split: a `pipeline` object with four stages
and a separate top-level `verify` object typed `device_io_assertion`. The
prose here matches that shape so an agent can map a UI element to a
contract field without translation.

### Service Composer

```
operator selects service + targets
       │
       ▼
POST /api/preview ─► newtcon-server ─HTTP─► newtron-server
                          │                       │
                          │                preview pipeline
                          │                (Intent → Replay → Render, Deliver skipped)
                          │                       │
                          │                ChangeSet per target
                          │                       │
                          ▼ ◄─────────────────────┘
preview rendered to operator
       │
       ▼  operator clicks "Apply"
POST /api/apply ───► newtcon-server ─HTTP─► newtron-server
                          │                       │
                          │                apply pipeline
                          │                (Intent → Replay → Render → Deliver)
                          │                       │
                          │                ChangeSet committed; intent on device
                          │                       │
                          │                then, as Device I/O (not a stage):
                          │                cs.Verify(n) re-reads CONFIG_DB
                          │                and asserts the ChangeSet landed
                          │                       │
                          ▼ ◄─────────────────────┘
per-target pipeline trace + verify assertion
```

### Operator Inbox

Inbox cards are derived from newtron signals: drift detection, convergence
status, in-flight operation state, reference-count warnings. The Inbox is a
projection of newtron's current state, not its own state machine.

When the operator acts on a card, the action flows back into the standard
pipeline along the same path as Composer actions: the frontend calls a
newtcon-server endpoint, the handler delegates to `internal/newtronc`, and
`newtronc` issues the corresponding HTTP request to newtron-server. For
example, "Enforce intent" on a drift card invokes a delta `Reconcile` on
the affected Node — newtron's primitive for patching only drifted entries
without a full config reload (see
`../newtron/docs/newtron/unified-pipeline-architecture.md` §Delta Reconcile).
newtcon surfaces the operation over newtron-server's HTTP API and translates
the response into the newtcon contract shape inside `internal/newtronc`. No
layer of newtcon imports a newtron Go package or invokes a newtron binary;
the boundary is the same network address used by every other newtcon →
newtron interaction.

### Change Workbench

The Workbench stages multiple intents in newtcon's own session state, then
delivers them as a single batched apply to newtron. The dry-run uses
newtron's sandbox-replay capability (intent snapshot/restore); the commit
delivers atomically where newtron's API guarantees it.

## Caching

newtcon's persistent state is limited to its observation-history layer (see
`internal/history/` or equivalent). Operational state (intent, projection,
ChangeSet, drift detection) is **never** cached persistently — it is sourced
live from newtron at query time. Per-request, the server may cache within a
handler call to avoid duplicate HTTP calls to newtron-server. Any cache
beyond that requires a contract decision (Architect PR) and must be
explicit, time-bounded, invalidatable, and surfaced with `as_of` timestamps
in the response.

Hidden caches violate `CLAUDE.md` §No Hidden State.

## Frontend Framework Selection

Deferred to the first frontend slice. The Architect makes the call based on:

- Bundle size (operator console, not consumer app — small dependency surface
  preferred).
- TypeScript first-class (the API contract is typed; the frontend must consume
  typed shapes without runtime parsing).
- Component model that supports the three operator surfaces without exotic
  patterns.

Candidate frameworks under consideration (informational, non-binding):
Svelte/SvelteKit, React + Vite, Solid, HTMX + minimal JS. The decision will
be recorded as an ADR in `docs/adr/`.
