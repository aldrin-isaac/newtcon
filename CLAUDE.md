# newtcon Project — Claude Code Instructions

newtcon is the operator-facing web console for newtron. This file is the
binding ruleset for every agent that touches this repo.

**Definitions in this document are specifications, not suggestions.** When a
section defines a term with precise meaning (e.g., "public API consumption,"
"design drift"), that definition is binding — it overrides any natural-language
interpretation of the phrase.

## Operator Philosophy: Intelligent Network, Intelligent Operator

The authoritative document is [`docs/operator-philosophy.md`](docs/operator-philosophy.md).
This section is a derivative summary.

**The principle:** newtron makes the network intelligent. newtcon
presents that intelligent network to the operator. The automation
**must make the operator MORE capable, not less**. An autopilot that
produces pilots who cannot fly when it fails is a defect; a network
automation tool that produces operators who cannot operate the network
manually when the automation fails has the same defect.

**The litmus test:** an operator who uses newtcon for a year must be
**more capable** than they were when they started. The strongest
expression of "more capable" is operators who file PRs at the method
level, not tickets at the symptom level — operators who have become
participants in the automation, not its consumers. Less capable →
newtcon has failed its purpose. See
[`docs/operator-philosophy.md`](docs/operator-philosophy.md) §The
litmus test and §Concrete success vision: operators as participants
for the full statement.

**Aesthetic discipline is co-equal with capability.** newtcon must be
beautiful, elegant, simple at first sight, and powerful one step in.
A substrate-exposing tool that is ugly, dense, or intimidating cannot
amplify capability — operators avoid such tools. A beautiful tool
that is shallow produces another Apstra with better fonts. The tool
must be both, layered: calm and inviting at first surface, navigably
deep beneath. The aesthetic litmus test: **does the operator want to
open this tool?**

**The nine capability invariants** (see [`docs/operator-philosophy.md`](docs/operator-philosophy.md)
for the full statement of each, plus the aesthetic-discipline demands
that govern presentation):

1. No black boxes — every automated action is fully inspectable.
2. Manual-mode parity — anything automation does, the operator can do
   by hand using their own tools (ssh + redis-cli + vendor CLI)
   directly against the device. newtcon teaches and exposes; it does
   not provide the manual surface.
3. The substrate is the teaching surface — intent records, projection,
   drift state, pipeline traces are legible and navigable.
4. Show before do — every action previews in domain terms before acting.
5. Why-mode is always available — every UI element navigates to its
   rationale and governing principle.
6. Rehearsal mode is real — operators practice manual control in a
   safe sandbox.
7. Errors carry the substrate — failures explained at the level the
   operator would see when doing it manually.
8. Operator-defined automation — policies are the operator's, visible
   and editable.
9. Confidence and limits are explicit — false confidence is worse than
   no confidence.

**Binding on every design decision.** The Architect cites these in
every Contract PR. The Architecture Reviewer checks every PR against
them. When this philosophy and any other principle in this file
disagree, the philosophy wins.

## Project Scope

newtcon delivers exactly three operator surfaces, in this order:

1. **Service Composer** — pick a service spec, pick N target interfaces across
   M nodes, preview the resulting ChangeSets, commit. The commit is **atomic
   per-Node** — each target Node's ChangeSet lands as a single TxPipeline
   write (newtron's `cs.Apply`, `ApplyDrift`, or `ReplaceAll`, depending on
   the verb; see `../newtron/docs/newtron/unified-pipeline-architecture.md`
   §6, §8 and `DESIGN_PRINCIPLES_NEWTRON.md` §8, §11). When a Composer
   batch spans multiple Nodes (M > 1), the per-Node commits are independent:
   newtron operates per-device and exposes no cross-Node atomicity
   primitive, so a multi-Node batch is **structured best-effort**, with
   each target's outcome reported separately in
   `POST /api/apply`'s `per_target[]` response. The operator sees, per
   target, whether the per-Node ChangeSet committed atomically, partially
   failed at validate / deliver / verify, or did not run because an earlier
   target failed and the batch policy was configured to halt. Same surface
   handles apply, refresh, and remove. See [`API_CONTRACT.md`](API_CONTRACT.md).
2. **Operator Inbox** — actionable cards for drift, convergence stragglers,
   partial operations, reference-count warnings, reconcile-due signals.
3. **Change Workbench** — staged batches of intents with dry-run preview,
   commit, stash, and revert. The commit is **atomic per-Node** — each
   target Node's batch lands as a single `Lock → snapshot → fn →
   commit-or-restore → Unlock` cycle whose inner application is a Redis
   `TxPipeline` write (see
   `../newtron/docs/newtron/unified-pipeline-architecture.md` §8 and
   `DESIGN_PRINCIPLES_NEWTRON.md` §8, §11, §31). When a Workbench batch
   spans multiple Nodes, the per-Node commits are independent and
   sequential: newtron operates per-device and exposes no cross-Node
   atomicity primitive, so a multi-Node commit is **structured
   best-effort**, with each Node's outcome reported separately in
   `POST /api/workbench/{batch_id}/commit`'s `per_target[]` /
   `per_node_atomicity[]` response and `cross_node_atomicity.atomic`
   fixed at `false`. The operator sees, per target, whether the per-Node
   batch committed atomically, partially failed at validate / deliver /
   verify, or did not run because an earlier target failed and the batch
   policy was configured to halt. Revert follows the same per-Node
   atomicity model. **No multi-batch atomic rollback.** newtron exposes
   per-operation reverse primitives (`DESIGN_PRINCIPLES_NEWTRON.md` §15
   operational symmetry); newtcon's Workbench exposes per-batch revert
   composed from those primitives. There is **no** "revert the last N
   committed batches in one call" primitive in newtron and **no**
   corresponding Workbench surface for history-walking undo. An operator
   who wants to undo a sequence of prior batches reverts each batch
   individually in reverse order, with per-batch per-Node atomicity at
   each step. Composers of an "undo last N batches" UI affordance (if
   any) would do so as a client-side sequence of
   `POST /api/workbench/{batch_id}/revert` calls; the per-step results
   are per-Node atomic, the overall sequence is best-effort. See
   [`API_CONTRACT.md`](API_CONTRACT.md) §Change Workbench, especially
   "The atomicity model — read this first."

**Out of scope** (do not implement, do not stub, do not propose):

- **Drag-and-drop blueprint editor** — the Apstra paradigm. Operators
  do not design networks in newtcon. Read-mostly topology
  visualization is *future-considered*, not out of scope; see below.
- Device-form configurators (per-device tabs with form fields for every CONFIG_DB table)
- Status dashboards with green/red lights as the primary surface
- Authentication/authorization (deferred until operator surfaces are validated)
- Multi-tenant features
- Mobile-first layouts

If a feature is not one of the three surfaces above and not in
`docs/roadmap.md`, it does not belong in newtcon. Out-of-scope work
is rejected at PR review.

**Future-considered** (NOT in current scope, but tracked for future
promotion — see [`docs/roadmap.md`](docs/roadmap.md)):

- **Spec authoring** — surfaces for operators to create / edit /
  delete service specs, profiles, zones. Bounded to the spec types
  operators commonly extend; routes through newtron's existing
  typed verbs.
- **Graphical topology visualization** — read-mostly tier-centric
  concentric-ring view of the network's physical structure, sourced
  from the topology spec. Structural changes route through spec
  authoring; this is a visualization layer, not a blueprint editor.

Future-considered items are deliberately deferred, not rejected on
principle. They are NOT picked up by the autonomous team. Promotion
from `docs/roadmap.md` to current scope is operator-driven via an
Architecture-class PR that updates this section and files
corresponding issues.

## Reference Documents

Authoritative documents live in the newtron repo. Read these before making
design decisions in unfamiliar areas:

| Document | Path (in `../newtron/`) | Purpose |
|----------|-------------------------|---------|
| newtron HLD | `docs/newtron/hld.md` | Architecture, intent model, Redis interaction |
| newtron LLD | `docs/newtron/lld.md` | Type definitions, method signatures, package structure |
| Pipeline Reference | `docs/newtron/unified-pipeline-architecture.md` | Intent → Replay → Render → Deliver |
| AI Instructions | `docs/ai-instructions.md` | Universal behavioral directives |
| **DESIGN_PRINCIPLES_NEWTRON** (foundational) | `docs/DESIGN_PRINCIPLES_NEWTRON.md` | newtron's authoritative principles. **Required reading for the Architect and Architecture Reviewer before every Contract PR.** newtcon's design must derive from and not contradict these. |

**newtcon does not re-document newtron's substrate.** When the UI exposes an
intent record, a ChangeSet, or a projection, those terms mean what newtron's
docs say they mean. Link, don't paraphrase.

## newtron API Consumption Rule

newtron is a separate application reached over HTTP. newtcon-server talks to
`newtron-server` (configured by `--newtron-url`, default
`http://127.0.0.1:<port>`) using JSON-over-HTTP, the same way `bin/newtron`
does.

newtcon does **not** import any newtron Go package, and **must not** add
newtron to `go.mod`. This rule has no exceptions:

- No `import "github.com/aldrin-isaac/newtron/..."` anywhere in newtcon.
- No `replace` directive for newtron in `go.mod` (there is no `require` to
  redirect, and adding one is rejected by the Critic on principle).
- No vendoring of newtron source.
- No copy-paste of newtron internal types — newtcon defines its own DTOs in
  `internal/types/` that match newtron's HTTP responses.
- No subprocess invocation of `bin/newtron` — the CLI is also an HTTP client,
  and newtcon goes direct.

All newtron interaction is mediated by one package, `internal/newtronc/`,
which is the only HTTP client of newtron-server in the codebase. CI enforces
this isolation: no other package may construct an `http.Client` or call
`http.Get`/`http.Post` against newtron-server's address.

If newtron's HTTP API does not expose what newtcon needs, follow the
**Gap-Handling Protocol** below. Do not work around the boundary.

## Gap-Handling Protocol

When implementing a slice or authoring a Contract PR, an agent may
discover that newtron's HTTP API does not expose required functionality.
The agent MUST:

1. **Stop implementing the feature.** Do not work around the gap.
2. **Open a newtron issue** (in newtron's repo, not newtcon's) titled
   `newtron HTTP API gap: <domain-term>`. The body must contain:
   - The gap described in domain terms (operator-facing intent), not
     implementation terms.
   - The proposed HTTP shape newtron should expose.
   - An **"Existing newtron API surveyed"** section enumerating what
     was checked and why it is insufficient (see below). A gap issue
     filed without this section is invalid; the gap is presumed not
     to exist until the survey is added.
3. **Mark the newtcon issue blocked** with a link to the newtron issue.
4. **Move to the next available slice.**

Forbidden under any circumstance:

- Adding a Go import of any newtron package.
- Adding a `replace` directive for newtron in `go.mod`.
- Vendoring newtron source into newtcon.
- Re-implementing newtron logic in newtcon "as a workaround."
- Calling `bin/newtron` (or any newtron binary) as a subprocess.
- Reading newtron's CONFIG_DB / APP_DB / etc. directly via a Redis client.
- **Filing a gap issue without an "Existing newtron API surveyed"
  section.**

If the gap blocks all available slices, halt and notify the operator via the
Drift Auditor's next report.

### Existing newtron API surveyed — required section in every gap issue

The autonomous agent team does not have direct access to newtron's
source. Architects and Implementers reason about newtron's API shape
by inference — a process that has produced confabulated gap reports
twice (newtron#3 was closed because the endpoint already existed at
`/intent/reconcile`; newtron#4/#5/#6 referenced composite endpoints
that do not exist in newtron's code). To force verification before
filing, every gap issue MUST include this section.

Enumerate, at minimum:

- The **routes table** at `../newtron/pkg/newtron/api/handler.go`
  `buildMux()` — list any routes whose name or path might cover the
  needed capability.
- The **handler implementations** at
  `../newtron/pkg/newtron/api/handler_node.go` and
  `handler_network.go` for any route examined.
- **Public Node methods** at
  `../newtron/pkg/newtron/network/node/node.go`.
- **Public Network methods** at
  `../newtron/pkg/newtron/network/network.go`.
- **Existing types** at `../newtron/pkg/newtron/types.go` and
  `../newtron/pkg/newtron/device/sonic/types.go`.

For each item examined, name the route/method/type and state why it
is insufficient — wrong shape, returns a summary instead of substrate
(`DESIGN_PRINCIPLES_NEWTRON.md` §46), requires N stitched calls,
doesn't exist, etc.

The survey is the operator's audit trail. Architecture Reviewer and
Critic both check that it is present and substantive on any newtcon
issue that links to a newtron gap. Filing without it, or with a
trivial "I didn't find anything" body, is rejected.

## File Ownership Map

Every feature lives in one file. A reader must be able to guess where
something is implemented from the file tree alone.

```
cmd/newtcon-server/main.go      → process entry, flag parsing, server boot
internal/server/                → HTTP routing, middleware, request lifecycle
  router.go                     → route registration
  middleware.go                 → logging, recovery, request ID
internal/handlers/              → one file per resource family
  services.go                   → /services, /services/{name}/instances, /services/{name}/candidates
  preview.go                    → /preview
  apply.go                      → /apply
  inbox.go                      → /inbox/* (when Inbox surface lands)
  workbench.go                  → /workbench/* (when Workbench surface lands)
  health.go                     → /health
internal/newtronc/              → the ONLY HTTP client of newtron-server
  client.go                     → HTTP client, base URL config, retry/timeout policy
  services.go                   → service-related newtron-server calls (list, instances, candidates)
  preview.go                    → preview/apply newtron-server calls, ChangeSet translation
internal/types/                 → API DTOs (request/response shapes)
  services.go                   → ServiceListResponse, ServiceInstance, etc.
  preview.go                    → PreviewRequest, PreviewResponse, ChangeSetDTO
web/                            → frontend (framework selected at first frontend slice)
docs/                           → architecture, ADRs
```

When adding new endpoints, find the existing handler file by resource family;
do not create new handler files unless adding a new resource family.

## Design Principles

These principles are derived from newtron's
`DESIGN_PRINCIPLES_NEWTRON.md`, adapted for the operator-UI surface. They
are binding on every agent.

**Derivation is mandatory.** newtcon's principles are not invented; they
operationalize newtron's principles for the UI layer. The Architect MUST
cite specific newtron principle sections when proposing changes to this
list (see `AGENTS.md` §Architect). A principle in newtcon that contradicts
a newtron principle is a bug.

newtcon surfaces newtron's architecture; it does not reshape it. Where
newtron has a word for something (ChangeSet, Intent, projection,
ApplyService, Reconcile, drift, validate/verify), newtcon uses that word.
New terminology in newtcon is a design smell.

### Service-First, Not Device-First

The operator's mental verbs are about services. The primary navigation is by
service, not by device. Device-centric views exist only as a secondary lens
when the operator drills down from a service instance.

Apstra and similar tools are device-first. newtcon is not.

### Pipeline-Aware UX

Every operation the UI initiates traces through newtron's pipeline
(Intent → Replay → Render → [Deliver]) and, when the operation delivered to
a device, the post-deliver Verify assertion. The UI surfaces both the
stage of each in-flight pipeline AND the state of the verify assertion —
not a binary success/failure, and not a single five-stage sequence.

Two concerns are deliberately not collapsed:

- **Pipeline stages.** Per
  `../newtron/docs/newtron/unified-pipeline-architecture.md` §2, the
  pipeline is `Intent → Replay → Render → [Deliver]` — four stages, with
  `Deliver` conditional on whether the caller commits the ChangeSet. The
  build stages produce expected state.
- **Verify.** Per the same document §7 and `DESIGN_PRINCIPLES_NEWTRON.md`
  §14, `cs.Verify(n)` is a **Device I/O operation**: it re-reads CONFIG_DB
  and asserts that what was delivered actually landed. Verify is a
  post-deliver assertion against the device, not a sibling of the build
  stages. `API_CONTRACT.md` §Operations reflects that split: a
  `pipeline` object with four stages and a separate top-level `verify`
  object typed `device_io_assertion`.

Two binding consequences for the UI:

- A `verify` whose state is not yet `complete` is shown as in-progress,
  not as success. An apply whose `deliver` stage completed but whose
  `verify.state` is still `in_progress` is not "done" — the operator sees
  both the pipeline trace and the verify state, and both must be terminal
  before the operation reads as success.
- A `deliver` stage of `skipped` is correct and expected for any
  operation that did not commit a ChangeSet (e.g., preview-only or
  Replay-only flows). Skipped is not failure; it is rendered as such.

### Preview Before Commit, Always

Every state-changing endpoint has a preview counterpart that returns the
ChangeSet (or set of ChangeSets) that would be produced. The UI never invokes
apply without first invoking preview and showing the result to the operator.

Exception: idempotent reads (GET endpoints) need no preview.

### Reference-Aware Removals

Every remove/teardown operation surfaces its reference-counted consequences in
the preview: which shared policies will be garbage-collected, which become
orphaned, which remain in use.

### Operator-Honest Errors

Errors are returned in domain terms, not HTTP-status approximations. A
validation failure from newtron's pipeline is surfaced with its validate-stage
output. A drift-guard refusal is rendered as a structured drift report, not as
"500 Internal Server Error."

Multi-target operations (multi-Node Composer batches, Workbench commits)
extend this honesty principle: the per-target outcome is reported per
target, not collapsed to a single batch verdict. A 200 response carrying
`aggregate.all_applied = false` is the correct shape for a partial
success; a partial-success batch MUST NOT be reported as a uniform
success or a uniform failure. This is operator-philosophy invariant #9
(Confidence and limits are explicit) made binding at the contract: the
honest shape — "Node A committed atomically, Node B failed at verify,
Node C did not run" — survives all the way to the operator.

### No Hidden State

No hidden state — the UI displays what newtron's intent/projection
actually says, sourced live from newtron at query time. newtcon's only
persistent state is observation history (snapshots, diffs, change
records over time) — and even this state is exposed honestly, with
timestamps and `observation_gap` markers for any window where polling
missed updates. Stale data is never rendered as current; cached
operational state never substitutes for a live read.

## Allowed Commands

Routine commands that do not require confirmation:

### Go Toolchain
- `go build -o bin/newtcon-server ./cmd/newtcon-server`
- `go test ./... -count=1`
- `go vet ./...`
- `go mod tidy`, `go list`, `go doc`, `go version`

### Frontend (once framework lands)
- `npm install`, `npm run build`, `npm run test`, `npm run lint`
- `npx <pinned-tool>`

### Git
- `git status`, `git diff`, `git log`, `git add`, `git commit`
- `git mv`, `git rm`, `git format-patch`

### Misc
- `ls`, `stat`, `file`, `wc`, `curl`, `jq`
- `curl` against `newtron-server` for HTTP API exploration during slice work

### Web Access
- `WebSearch` (always allowed)
- `WebFetch` for `github.com`, `pkg.go.dev`, framework docs

## Build Convention

Always `go build -o bin/newtcon-server ./cmd/newtcon-server` — `go run`
compiles to a temp directory and breaks sibling binary resolution patterns.

## Regression Prevention

Before changing any handler, the agent MUST:

1. List which API contract endpoints exercise this handler.
2. Verify the change does not alter response shape unless `API_CONTRACT.md` is
   updated in the same PR.
3. Run `go test ./... -count=1` and confirm all previously passing tests pass.
4. Confirm the contract-snapshot test passes (CI gate).

Contract changes are a separate PR class — see [`AGENTS.md`](AGENTS.md).

## Greenfield — No Backwards Compatibility

newtcon is greenfield. No compatibility shims, no API versioning until v1,
no deprecated aliases. Delete, don't deprecate. The pinned newtron dep absorbs
all upstream compatibility concerns.

## Agent Team

See [`AGENTS.md`](AGENTS.md) for the binding team structure: roles, models,
invocation triggers, coordination protocol, and review gates.
