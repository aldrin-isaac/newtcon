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

**Vocabulary.** This section uses **the substrate** as a shorthand for the
canonical typed data that newtron and newtrun expose over HTTP — CONFIG_DB
entries, intent records, ChangeSets, projection snapshots, verify
assertions, observation snapshots, and per-write operation records. The
canonical definition lives at
[`docs/operator-philosophy.md`](docs/operator-philosophy.md#vocabulary-what-the-substrate-means-in-this-document)
§Vocabulary; this section, and every CLAUDE.md section that uses the
term in the canonical sense, inherits that definition by reference per
editing-guidelines §43. Compound phrases like "orchestration capability"
and "scenario YAML" elsewhere in this file describe newtrun's surfaces
in their own terms; they are not the canonical substrate.

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

newtcon's user-facing mission is **the operator-facing web console for
production network operators** — a daily-work tool. The operator who uses
newtcon for a year must be more capable than they were when they started.
The mission is unchanged from the project's outset; **what changed is the
engine partition underneath it**. Per
[`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)
(Status: Accepted, 2026-05-28), the implementation that delivers the
operator workflows is split across three peer tools — newtron
per-device, newtrun orchestration, newtcon
observation-history-plus-the-browser-frontend.

newtcon ships **two artifacts**:

### Artifact 1 — newtcon-server (Go HTTP service)

The post-rebalance newtcon-server is the service newtcon *uniquely*
owns. It is the smaller, observation-side service that the rebalanced
architecture leaves on newtcon's side of the boundary. Four layers:

1. **Observation History** — the SQLite polling store with adaptive
   per-Node polling, `change_id` / `observation_id` /
   `observation_gap` markers, and the
   `source: newtron_mediated | out_of_band` discrimination engine.
   This is the load-bearing reason newtcon-server exists and is the
   binding "no black boxes" affordance for operators who need to see
   substrate change over time (including changes that newtcon did not
   initiate). See [`API_CONTRACT.md`](API_CONTRACT.md) §Endpoints —
   Observation History.
2. **Report Bug** — substrate-grounded bug-report body composition
   with the `clipboard` / `direct_file` delivery modes. Depends on
   Observation History for recent-context blocks and on newtrun's
   run state for operation-trace blocks. See
   [`API_CONTRACT.md`](API_CONTRACT.md) §Endpoints — Report Bug.
3. **Provenance** (probably thin proxy) — read-only substrate
   inspection (intents, projection, changesets, verify). Per the
   ADR-0001 verdict's borderline-bucket framing, the **final shape is
   deferred**: as the Observation History layer matures the right
   call sharpens (likely a thin proxy in front of newtron with
   cross-reference fields). See [`API_CONTRACT.md`](API_CONTRACT.md)
   §Endpoints — Provenance.
4. **Teaching catalogs** (static content) — Manual-Mode Parity and
   Rehearsal. Static markdown / structured content addressable by
   ID. Could be served by any static HTTP server; rides along with
   newtcon-server for convenience. See
   [`API_CONTRACT.md`](API_CONTRACT.md) §Endpoints — Manual-Mode
   Parity (teach surface) and §Endpoints — Rehearsal (teach surface).

newtcon-server is **roughly 25-35 % of the line-count and complexity**
of the pre-rebalance architecture (per ADR-0001 §Consequences). The
post-rebalance contract reflects this scale.

### Artifact 2 — the browser frontend

The browser frontend is the load-bearing operator experience. It
delivers the **three operator workflows** by composing two HTTP
backends:

1. **Service Composer** — pick a service spec, pick N target
   interfaces across M nodes, preview the resulting ChangeSets,
   commit. Delivered by the frontend over **newtrun-server**'s
   orchestration capability (`POST /api/runs/inline` for stateless
   compose-and-run; SSE event replay for streaming per-write
   visibility). The atomicity model — **per-Node atomic, multi-Node
   structured best-effort** — is unchanged; newtrun-server's
   per-scenario lifecycle and step-progress events surface the same
   substrate signal the architected newtcon-server contract did.
2. **Operator Inbox** — actionable cards for drift, convergence
   stragglers, partial operations, reference-count warnings,
   reconcile-due signals. Delivered by the frontend composing
   newtrun-server's run history (`GET /api/runs`,
   `GET /api/runs/{suite}/events` SSE) with newtcon-server's
   Observation History.
3. **Change Workbench** — staged batches of intents with dry-run
   preview, commit, stash, and revert. Delivered by the frontend
   over newtrun-server's scenario mechanism (`POST /api/suites`,
   `POST /api/runs/inline`, scenario CRUD per newtron#33). The
   per-Node atomicity model is preserved; the staging mechanism is
   newtrun's scenario YAML.

The browser frontend also surfaces newtcon-server's Observation
History, Provenance, Report Bug, and Teaching Catalogs alongside the
three operator workflows. The operator opens **one tool**; the frontend
composes two backends and surfaces a single integrated console.

### What the rebalance preserves and what it changes

**Preserved:**

- The mission — daily-work operator console for production operators.
- The three operator workflows — Composer, Inbox, Workbench all still
  deliver, just over a sharper architectural boundary.
- The nine operator-philosophy invariants — binding on every contract
  decision, every UI element, every error envelope.
- The aesthetic discipline — calm at first surface, navigably deep
  beneath; the operator wants to open this tool.
- The "simple yet powerful, no tedious graphical CLI" litmus test.
- Per-Node atomicity for Composer applies and Workbench commits.
- The reference-aware-removals discipline.
- The "show before do" discipline (preview before commit, always).

**Changed:**

- The orchestration engine for the state-changing workflows moves out
  of newtcon-server and into newtrun-server. The browser frontend
  consumes newtrun-server directly for those workflows.
- newtcon-server's contract scope narrows to Observation History +
  Report Bug + Provenance (probably thin) + Teaching catalogs.
- Streaming per-write events are surfaced by newtrun-server's
  SSE (`GET /api/runs/{suite}/events` carrying `EventStepProgress`
  with verbatim `sonic.DeviceOp` per newtron's §46 wire-shape
  principle). newtcon-server's previously-architected SSE surface for
  apply/preview/workbench moves to newtrun-server.

### Out of scope

(Do not implement, do not stub, do not propose.)

- **Drag-and-drop blueprint editor** — the Apstra paradigm. Operators
  do not design networks in newtcon. Read-mostly topology
  visualization is *future-considered*, not out of scope; see below.
- Device-form configurators (per-device tabs with form fields for every CONFIG_DB table)
- Status dashboards with green/red lights as the primary surface
- Authentication/authorization (deferred until operator surfaces are validated)
- Multi-tenant features
- Mobile-first layouts
- **Re-implementing orchestration capability that newtrun-server
  already exposes.** Per the survey-adjacent-tools rule below and
  ADR-0001's substantive analysis, surfaces that duplicate
  newtrun-server's orchestration capabilities are rejected at PR
  review on principle, even when they would be in-scope as
  "operator workflow."

If a feature is not one of the four newtcon-server layers above (and
not part of the browser frontend's composition of the two backends),
and not in `docs/roadmap.md`, it does not belong in newtcon.
Out-of-scope work is rejected at PR review.

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
| **newtrun HLD** (peer tool) | `docs/newtrun/hld.md` | The orchestration capability the browser frontend consumes for Composer / Inbox / Workbench workflows. newtrun-server's HTTP API (newtron#22/#23/#24, landed; newtron#33, in flight) is the load-bearing surface for state-changing operator workflows post-rebalance. **Peer status** — see §Survey adjacent tools below. |
| newtrun HOWTO (peer tool) | `docs/newtrun/howto.md` | Scenario authoring, suite layout, lifecycle verbs. |
| newtrun LLD (peer tool) | `docs/newtrun/lld.md` | Types and method signatures the HTTP API mirrors. |
| AI Instructions | `docs/ai-instructions.md` | Universal behavioral directives for Claude Code, scoped by activity phase (ALL / PLAN / IMPL / EXPLAIN / TEST / REVIEW). Binding on every newtcon agent role — see §Agent Team Required Reading. |
| Documentation Editing Guidelines | `docs/editing-guidelines.md` | Universal documentation-craft principles, scoped by document type (ALL / DESIGN / HLD / LLD / HOWTO / README / API / GUIDE) and quality-tiered. Binding on every newtcon agent that authors or edits documentation — see §Agent Team Required Reading. |
| **DESIGN_PRINCIPLES_NEWTRON** (foundational) | `docs/DESIGN_PRINCIPLES_NEWTRON.md` | newtron's authoritative principles. **Required reading for the Architect and Architecture Reviewer before every Contract PR.** newtcon's design must derive from and not contradict these. |

**newtcon does not re-document newtron's typed data or newtrun's
orchestration vocabulary.** When the UI exposes an intent record, a
ChangeSet, a projection, a scenario, a step, or a run, those terms mean
what the upstream docs say they mean. Link, don't paraphrase.

### Survey adjacent tools before scoping a new surface

**The lesson of ADR-0001
([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md))
made binding.** Before scoping a new operator surface, the Architect (and
the Architecture Reviewer, and the Critic for any cross-cutting check)
MUST verify against the existing capabilities of newtrun and any other
adjacent project tool whether the proposed surface is **genuinely new
capability** or a **presentation layer over capability the project
already has**.

The pre-rebalance failure mode was structural: newtrun was named in this
section as "[a] document [to] read before making design decisions in
unfamiliar areas," but it was operationally treated as adjacent context
rather than as a peer with overlapping operator-facing scope. The result
was that the Composer / Inbox / Workbench contract surfaces substantially
re-implemented orchestration capabilities newtrun already shipped, and
the only operator-visible delta was a browser frontend versus YAML +
terminal. ADR-0001 made the architectural boundary honest; this rule
prevents the failure mode from recurring.

The survey discipline:

1. **Identify peer tools.** At minimum: newtron (per-device capability),
   newtrun (orchestration capability, now extended with
   newtrun-server's HTTP surface — see the table above). Any future
   adjacent project tool added to the project's tool stack joins this
   list.
2. **Read their actual capabilities.** Not their docs' surface
   description — their HLD, their HTTP API, their state model.
   ADR-0001's capability-boundary analysis is the worked example: §What
   newtrun actually is (verified by reading the source).
3. **Classify the proposed surface.** Per ADR-0001's three buckets:
   **A (duplicative)** — peer tool already produces this capability;
   reject the surface and use the peer; **B (uniquely newtcon)** —
   capability the peer cannot produce by construction; proceed;
   **C (borderline)** — peer could produce with modest extension;
   weigh cost-of-extension against cost-of-newtcon-implementation
   substantively, not by reflex.
4. **Document the classification in the Contract PR description.**
   The "Considered alternatives" section (mandatory per
   [`AGENTS.md`](AGENTS.md) §Architect) MUST include "would this be
   better implemented in newtrun (or another peer tool)?" as one
   of the alternatives, with non-strawman reasoning either way.

The Architecture Reviewer rejects Contract PRs whose Considered
Alternatives section lacks an explicit peer-tool survey for any
surface that touches orchestration, lifecycle, scenarios, runs,
events, or any other capability already present in newtrun. The
Critic applies the same check on the consistency side.

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

### Agent Team Required Reading

Two newtron docs are binding mandatory reading for the newtcon agent team,
scoped by role and activity phase. Both are referenced — not paraphrased —
per the "link, don't paraphrase" rule above; future drift in the upstream
docs is absorbed automatically by re-reading.

- **`../newtron/docs/ai-instructions.md`** — universal behavioral
  directives, scoped by activity phase (ALL / PLAN / IMPL / EXPLAIN /
  TEST / REVIEW).
- **`../newtron/docs/editing-guidelines.md`** — universal
  documentation-craft principles, scoped by document type (ALL /
  DESIGN / HLD / LLD / HOWTO / README / API / GUIDE) and
  quality-tiered.

The binding obligations per role:

- **Architect** — read `editing-guidelines.md` (ALL plus the scope
  tags matching the document being authored or revised: DESIGN for
  principle work, HLD for `docs/architecture.md`, API for
  `API_CONTRACT.md`) before any edit to `CLAUDE.md`,
  `API_CONTRACT.md`, `docs/architecture.md`, or an ADR. Read
  `ai-instructions.md` (ALL, PLAN, REVIEW tags) before authoring or
  revising any binding rule.
- **Architecture Reviewer** — apply `editing-guidelines.md`
  (relevant scope tags for the document under review) and
  `ai-instructions.md` (ALL, REVIEW tags) when reviewing every
  Architect-authored PR. Reviews that do not surface
  editing-guidelines violations on documentation PRs, or
  ai-instructions violations on design PRs, are themselves incomplete.
- **Tech Lead** — read `ai-instructions.md` (ALL, PLAN tags) when
  slicing features into issues. Slices must satisfy directive 14
  (resolve risks in plans) and directive 15 (detailed trackers)
  before issuing.
- **Implementer** — read `ai-instructions.md` (ALL, IMPL, TEST tags)
  before writing code or tests. Read `editing-guidelines.md` (ALL
  plus scope tags matching any document being touched — typically
  none, since Implementers are forbidden from editing the
  Architect-owned docs; but in-code comments, handler-level
  godoc, and test descriptions are still documentation and the ALL
  principles apply).
- **Critic** — apply `editing-guidelines.md` (relevant scope tags)
  and `ai-instructions.md` (ALL, REVIEW tags) on every PR. The
  Critic's seven binding consistency checks (`AGENTS.md` §Critic)
  remain authoritative; the editing-guidelines and ai-instructions
  layer on top, not replace.
- **Drift Auditor** — apply both docs' principles when auditing
  systemic drift across the week's merged diff. Specifically,
  `editing-guidelines.md` §4 (each concept explained exactly once),
  §11 (document what is, not what's intended), and §41 (audit
  overloaded terms throughout); and `ai-instructions.md` §9
  (post-implementation conformance audit), §11 (do not speculate),
  and §20 (authoritative source precedence) are the principles most
  likely to surface systemic drift the per-PR Critic cannot see.

These obligations do **not** enumerate the principles themselves —
the upstream docs are the authority. An agent that has not opened the
relevant doc before acting is acting against this rule, even if their
output happens to be consistent with the principles by accident. The
"link, don't paraphrase" discipline above applies to this binding
clause as much as it applies to substrate concepts: the principles
live in the upstream documents, and the upstream documents are what
the agent reads.
