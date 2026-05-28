# 0001. Scope justification of newtcon versus newtrun

Status: Proposed
Date: (filled at merge)

## Context

### The operator's question (2026-05-28, verbatim)

> "how is what you architected uniquely different from say a UI and event
> subsystem over newtrun (see newtron's repo)? is what you are creating a
> subset of what newtrun does considering production scenarios are a
> subset of lab scenarios? what are you doing at the engine-level that is
> truly unique to newtron vs just another flavor of it — i.e. a duplicate
> effort?"

The question lands at the moment newtcon's Composer milestone is in
flight (slice #79 merged 2026-05-28, slices #80/#81/#82 not yet
spawned), `API_CONTRACT.md` has reached 10,904 lines defining 50
endpoints across 9 surface families, and the first cumulative drift
audit (`docs/audits/2026-05-28.md`) flagged a 2 % implemented-vs-
specified ratio. The Architect has never substantively read newtrun's
HLD / HOWTO / source. Every newtcon design choice to date has been
made against newtron's substrate and the operator-philosophy, *not*
against newtrun's actual capabilities. This ADR closes that gap.

### What newtrun actually is (verified by reading the source)

`pkg/newtrun/` (~3,800 LOC of Go) plus `cmd/newtrun/` (~1,200 LOC) plus
the `newtrun/topologies/` and `newtrun/suites/` asset trees. Surveyed
documents: `../newtron/docs/newtrun/hld.md`,
`../newtron/docs/newtrun/howto.md`, `../newtron/docs/newtrun/lld.md`,
the five `../newtron/docs/diagrams/newtrun-*.dot` system diagrams, and
the per-file source listed above. Key load-bearing properties:

1. **newtrun is a general-purpose orchestrator over newtron's HTTP API.**
   `hld.md` §1: "newtrun is a general-purpose test framework. Users
   write their own topologies and suites as YAML scenario files and
   spec directories." `hld.md` §3: "newtrun is one orchestrator built
   on top of newtron and newtlab — not the only one. Other
   orchestrators could be built for different purposes (production
   deployment, CI/CD pipelines, compliance auditing)." The
   self-positioning is explicit: newtrun is *one* orchestrator
   pattern, not the canonical operator surface.

2. **The substrate of a newtrun "scenario" is YAML.** A scenario is a
   topologically-ordered list of steps (`pkg/newtrun/scenario.go`);
   each step is one of six actions (`topology-reconcile`,
   `verify-topology`, `wait`, `host-exec`, `newtron`, `newtron-cli`).
   The `newtron` action is a thin pass-through of `{method, url,
   params, poll?, batch?, expect?}` to newtron-server — the same HTTP
   API newtcon's `internal/newtronc/` consumes.

3. **newtrun has persistent state.** `pkg/newtrun/state.go`:
   `RunState`, `ScenarioState`, `StepState`, serialized to
   `~/.newtron/newtrun/<suite>/state.json`. Captures suite status
   (`running` / `pausing` / `paused` / `complete` / `failed` /
   `aborted`), per-scenario status, current step, durations,
   per-step results, and skip reasons. Updated after every scenario
   start, scenario end, and step start — *real-time progress
   monitoring is already an existing newtrun primitive*. `newtrun
   status --monitor` already auto-refreshes every 2 s.

4. **newtrun orchestrates multi-device work and renders results.**
   The "verification tiers" table in `hld.md` §7 puts cross-device
   verification (route propagation, dataplane ping) explicitly in
   newtrun's column. `DESIGN_PRINCIPLES_NEWTRON.md` §14 makes this
   binding: cross-device "correctness" judgments are
   orchestrator-owned because newtron operates per-device. newtrun
   already implements that column. Three output formats: real-time
   console (verbose mode shows per-step results with timing),
   markdown report (`newtrun/.generated/report.md`), JUnit XML.

5. **newtrun executes lifecycle workflows.** `start` /
   `pause` / `stop` / `status` / `list` / `topologies` / `actions`
   are the CLI verbs. Lifecycle is "deploy topology (or reuse via
   `EnsureTopology`) → run scenarios in dependency order → leave
   topology running for follow-on work / inspection → operator
   tears down via `stop`." The pattern is operationally indistinct
   from "stage a batch of work, apply it, observe the result,
   commit or back out."

### What newtcon is, as currently architected

`CLAUDE.md` §Project Scope plus the operator-philosophy invariants
plus the eight surface families now defined in `API_CONTRACT.md`:

1. **Service Composer** — pick service spec + targets, preview
   ChangeSets, commit per-Node-atomic.
2. **Operator Inbox** — five card kinds (`drift`,
   `convergence_straggler`, `partial_operation`,
   `reference_warning`, `reconcile_due`) derived live from newtron
   reads.
3. **Change Workbench** — stage / dry-run / commit / stash / revert
   batched intents.
4. **Provenance** — `GET /api/intents/{id}`,
   `/api/projection/nodes/{node}`, `/api/projection/services/{svc}`,
   `/api/changesets/{id}`, `/api/operations/{id}/verify`.
5. **Manual-Mode Parity (teach surface)** — static, read-only
   `GET /api/manual/...` teaching content; no execution path.
6. **Rehearsal (teach surface)** — static, read-only
   `GET /api/rehearsal/walkthroughs/...`; no execution path.
7. **Observation History** — newtcon-owned SQLite store of polled
   substrate snapshots, with `change_id` / `observation_id` /
   `gap_id` and `source: newtron_mediated | out_of_band`
   classification.
8. **Report Bug** — substrate-canonical bug-report body
   composition + delivery (`clipboard` / `direct_file`).
9. Streaming substrate-operation events (cross-cutting; SSE on
   the three state-changing endpoints).

## Decision

### Verdict: **Hybrid (verdict 3).**

The newtcon surfaces split cleanly into three buckets when held up to
newtrun's actual capabilities:

- **Bucket A — Duplicative.** A frontend + event subsystem over newtrun
  would deliver this with comparable substrate fidelity at lower
  cost. The newtcon-server primitive in this bucket has no engine-
  level uniqueness; it is "newtron HTTP call + presentation," which
  is exactly what newtrun's `newtron` action already does in YAML.
- **Bucket B — Uniquely newtcon.** Substrate that newtrun does not
  produce by construction (not "doesn't ship today" — *cannot
  produce given its design intent*), where building it inside
  newtrun would violate one of newtrun's own principles or its
  scope boundary.
- **Bucket C — Hybrid / could-go-either-way.** Substrate that
  newtrun could produce with a modest design extension (less than
  a major reframe), but for which there is a substrate-honest
  reason to build it in newtcon instead.

The classification below is the substantive decision. The
**Consequences** section converts the classification into the
concrete deprecate / keep / fold list.

### Bucket A — Duplicative with newtrun (deprecate)

1. **Service Composer apply / preview / refresh / remove.** The
   Composer is, in substrate terms, "pick a service spec, choose
   targets, see what ChangeSet would be produced, optionally commit
   it." A newtrun scenario with three steps
   (`newtron POST /api/preview`, operator-review pause,
   `newtron POST /api/apply`) plus a frontend that renders the
   first step's response, requests operator confirmation, and
   submits the third is operationally indistinct. newtrun already
   has dependency ordering, per-step result capture, real-time
   progress (`status --monitor`), and JUnit / markdown reporting.
   The only thing it lacks is a browser-rendered preview-and-confirm
   surface — a frontend, not a server.

2. **Change Workbench stage / dry-run / commit / stash / revert.**
   This is the same pattern as Bucket A.1 with an explicit batch
   container. Staging is "compose a YAML scenario." Dry-run is
   `newtrun start --no-deploy` against newtron's sandbox replay.
   Commit is `newtrun start <stash>`. Stash is "save the YAML to
   `~/.newtron/newtrun/<stash-name>/`." Revert is a generated
   reverse-scenario per the `DESIGN_PRINCIPLES_NEWTRON.md` §15
   operation pairs. Every primitive newtcon's Workbench needs
   already exists in newtrun's scenario format and state-persistence
   layer. The newtcon-server contribution is composing them; that
   composition layer is a YAML generator the frontend could write
   into newtrun's suite directory directly.

3. **Streaming substrate-operation events (SSE wrapping).**
   newtrun's progress reporter (`pkg/newtrun/progress.go`,
   `ProgressReporter` / `consoleProgress` / `StateReporter`) already
   emits per-step events to two sinks (console + persistent state
   file). Extending that to a third sink (SSE to a browser) is a
   modest refactor. The wire shape (`PerWrite`) is upstream
   newtron's responsibility per `DESIGN_PRINCIPLES_NEWTRON.md` §46
   "Wire Shape Mirrors Substrate"; newtcon-server does not produce
   `PerWrite` entries, it forwards them from newtron. newtrun
   forwards them in the same direction with the same translation
   cost.

4. **Operator Inbox.** Each card kind maps directly to a single
   newtron endpoint: `drift` to `GET .../drift`,
   `convergence_straggler` to polling `GET .../operations/{id}`,
   `partial_operation` to `GET .../zombie`, `reference_warning` to
   newtron's reference scan, `reconcile_due` to comparing
   `last_reconcile_at` against a configured cadence. The newtcon-
   server's contribution is *polling* and *card-kind framing*. A
   newtrun "inbox" scenario could be a single
   `verify-topology`-shaped batch run on a cron; the YAML-defined
   `expect` block already discriminates pass/fail/condition; the
   `state.json` already carries the per-scenario result an inbox
   surface would render. The inbox's "dismissal" semantics are
   client-side filter state — they can live in browser local storage
   or in a tiny key/value sidecar; no substantive server needed.

### Bucket B — Uniquely newtcon (keep — these are the load-bearing reasons newtcon exists)

1. **Observation History (per `API_CONTRACT.md` §Endpoints —
   Observation History).** This surface is **structurally outside
   newtrun's scope** for three reasons that the contract section
   itself enumerates and that the substrate-by-substrate
   comparison confirms:
   - newtrun's `state.json` captures **test run** history, not
     **substrate observation over time**. The state file records
     "scenario X passed at T1 against this topology"; it does not
     record "device switch1's CONFIG_DB looked like X at T1, Y at
     T2, Z at T3, and the diff between T2 and T3 corresponds to
     no operation newtcon initiated (`source: out_of_band`)."
   - newtrun does not have a polling layer. It runs scenarios on
     operator demand; between runs, the substrate is unobserved.
     Adding "background per-Node polling at adaptive cadence with
     `observation_gap` markers" to newtrun would change what
     newtrun is — from "an orchestrator that runs and exits" to
     "a long-lived daemon that watches devices." That is a scope
     expansion newtrun's principles do not contemplate.
   - The `source: newtron_mediated | out_of_band` discrimination
     requires correlating *every* observed change against *every*
     operation newtcon-server has initiated, including those
     initiated outside any newtrun-run-window. The correlation
     substrate is exactly the long-lived operation store newtcon-
     server maintains; newtrun does not have one because newtrun
     does not initiate operations outside its own scenarios.

   This is the strongest engine-level argument for newtcon-server's
   existence. The audit is binding even though `newtron/docs/newtron/
   api.md` §11 documents an aspirational `GET .../history` endpoint;
   the contract section explains why pushing this into newtron would
   violate newtron's §1, §20, §21, and §27. So the gap belongs to
   newtcon, and within the newtcon-vs-newtrun framing the gap belongs
   to newtcon-server, not to newtrun.

2. **Manual-Mode Parity (teach surface) and Rehearsal (teach
   surface).** These are **static teaching catalogs**, addressable
   by ID, that point at the operator's-own-tools (ssh + redis-cli +
   vendor CLI). The teaching content does not exist in newtrun and
   building it in newtrun would be a category error: newtrun is an
   orchestrator (it runs things); teaching catalogs are a different
   substrate (they explain things, and explicitly direct the
   operator *off* newtcon and *off* newtron into their own ssh
   session). Per `docs/operator-philosophy.md` invariant #2's
   refinement, manual-mode parity exists precisely so that the
   operator can act when newtron and newtcon are themselves the
   failure mode; baking the teaching catalog into newtrun would
   subordinate the catalog to the very tool whose unavailability
   the catalog must survive. **But:** the teaching catalogs are
   static content authored by the Architect. They could live in a
   newtrun docs subdirectory, served by any static-file server, with
   the same operator value. The newtcon-server's contribution is
   *addressable HTTP retrieval*; the substantive substrate is the
   markdown / structured content itself. If the Composer / Inbox /
   Workbench surfaces are deprecated, the teaching catalogs survive
   them but do not justify a separate server on their own.

3. **Report Bug (substrate-canonical bug report composition).**
   This surface depends on two substrates newtrun does not produce:
   - Long-lived per-operation history beyond the lifetime of a
     single newtrun run. The Report Bug body references the
     operation's `PerWrite`, the pipeline trace, the verify
     assertion — all of which newtrun captures *during a run* but
     evicts at run end (or at most retains in the markdown report,
     not in addressable per-operation form).
   - The Observation History recent-context block. Bug reports
     embed "what else was happening on this Node in the last 30
     minutes," which requires the polling layer from B.1.
   Report Bug is therefore parasitic on B.1 — if B.1 is deprecated,
   B.3 falls. If B.1 is kept, B.3 is the structural payoff that
   makes B.1 worth maintaining. The two surfaces stand or fall
   together.

### Bucket C — Hybrid / either-fits (decide by cost)

1. **Provenance (read-only substrate inspection — intents,
   projection, changesets, verify).** These endpoints are
   substrate-faithful translations of newtron's HTTP responses
   into a more navigable shape with stable URLs and cross-
   reference fields (`changeset_url`, `intent_url`, `operation_url`
   companions). A newtrun extension could expose the same data
   through the `newtron` action's `expect: jq` block, but the
   surface would be less ergonomic for a browser (each `jq`
   evaluation is a separate scenario step). The newtcon-server
   contribution here is **HTTP shape ergonomics for a browser**, not
   substrate. Could go either way. If the Composer / Inbox /
   Workbench surfaces deprecate, Provenance survives because it
   feeds B.1's recent-context and B.3's substrate citation; if
   those deprecate too, Provenance is best implemented as a thin
   read-only proxy with no server-side logic.

### Substantive reasoning behind the verdict

The honest summary is that newtcon was architected as if newtron
were the only adjacent thing in the world. newtrun was named in
`CLAUDE.md` §Reference Documents as "[a] document [to] read before
making design decisions in unfamiliar areas," but the Architect
never operationally treated it as a peer with overlapping operator-
facing scope. The result is that **the Composer / Inbox / Workbench
trio — the entire Bucket A — substantially re-implements
orchestrator capabilities newtrun already ships**, and the only
operator-visible delta is a browser frontend rather than YAML +
terminal. The operator's question is structurally correct.

**The argument for keeping the Composer surface that is NOT
duplicative** comes down to one thing: the operator-philosophy
invariants demand a presentation layer that aggressively exposes the
substrate (no black boxes, show before do, why-mode), and that
presentation layer wants a typed JSON contract per surface (the
`API_CONTRACT.md` shape) rather than a `jq`-against-`expect` shape.
That is a real difference of substrate, but it is a *presentation*
difference, not an *engine* difference. The right realization of the
philosophy on top of newtrun is a frontend that consumes newtrun's
state.json + a thin HTTP-event subsystem and renders the existing
substrate with the philosophy's discipline. That is much smaller
than newtcon-server-as-currently-architected.

**The argument for newtcon-server's existence narrows to two
load-bearing things:** (1) Observation History + the Report Bug
surface that depends on it, and (2) the substrate-correlation engine
that distinguishes `newtron_mediated` from `out_of_band` changes.
Both require persistent state on the newtcon side and a long-lived
process polling newtron at adaptive cadence. Neither fits in
newtrun's scope without reframing what newtrun is. The teaching
catalogs (Manual-Mode Parity, Rehearsal) are real value but are
deliverable as static content under any HTTP server; they do not
themselves justify a substantial newtcon-server.

The verdict is **hybrid**, and the rebalance is severe — newtcon-
server's center of gravity moves from "the operator's primary
write surface for newtron" to "the observation-history substrate
plus its derived surfaces." Most of what `API_CONTRACT.md` currently
defines as state-changing surface is duplicative and should be
deprecated in favor of "frontend + event subsystem over newtrun."

## Consequences

### Immediate (if accepted)

1. **Pause spawning slices #80, #81, #82 (Composer milestone
   slices 2–4 of 4).** Slice #79 is merged and harmless (server
   scaffolding + health endpoint); slices 2–4 build `/api/services`,
   `/api/preview`, `/api/apply` — all Bucket A. Implementing them
   produces code that the rebalance will then delete. Hold the
   slice queue.

2. **Pause spawning the Composer frontend slice (`/tmp/newtcon-
   issues/04-frontend.md`).** The frontend remains the right
   layer for the philosophy invariants, but its backend changes —
   it should consume newtrun's HTTP-event subsystem (to be filed
   as a newtron / newtrun issue) and a much-smaller newtcon-server,
   not the Composer-as-architected.

3. **The operator reviews this ADR.** It is filed as
   `Status: Proposed` (the ADR README's exception clause for ADRs
   that need operator-side approval). The Architect does not land
   it as Accepted unilaterally; the rebalance is severe enough to
   warrant explicit operator sign-off.

4. **If the operator accepts the verdict,** a follow-up batch of
   Architecture-class PRs lands:
   - `CLAUDE.md` §Project Scope is rewritten. The "three operator
     surfaces" framing is replaced with "newtcon-server provides
     observation history, report bug, and the teaching catalogs;
     Composer / Inbox / Workbench operator workflows are served
     by a newtcon frontend over newtrun."
   - `API_CONTRACT.md` is split: the surfaces that stay
     (Observation History, Report Bug, Provenance, Manual-Mode
     Parity, Rehearsal) remain in newtcon's contract; the
     surfaces that move (Composer, Workbench, Inbox, Streaming)
     are filed as newtrun extension issues (see "What moves
     upstream" below).
   - `docs/architecture.md` is rewritten to reflect the smaller
     newtcon-server.
   - The PR queue (`/tmp/newtcon-issues/02-services-endpoint.md`,
     `03-preview-apply.md`, `04-frontend.md`) is reframed.
     #02 and #03 are discarded; #04 (frontend) is rescoped to
     "frontend over newtrun + a small newtcon-server for
     observation history."

### What moves upstream (newtrun / newtron issues)

If the operator accepts, the following newtron/newtrun issues are
filed (operator-driven; per `CLAUDE.md` §Gap-Handling Protocol the
autonomous team does not file across the boundary):

- **newtrun: HTTP-event subsystem.** Today newtrun's progress
  reporter targets two sinks (console, `state.json`). Add a third
  sink: a long-lived HTTP server that serves the current
  `state.json` over `GET /api/state` and the live event stream
  over `GET /api/events` (SSE). Wire shape mirrors the existing
  `StepState` / `ScenarioState` types.
- **newtrun: stateless "compose-and-run" mode.** Today newtrun
  scenarios are authored as files. Add a `POST /api/run` endpoint
  that accepts an inline scenario YAML / JSON, runs it with the
  same lifecycle as a file-backed scenario, and returns the
  operation ID. The frontend uses this to translate browser
  operator clicks into newtrun runs without writing to the
  filesystem.
- **newtrun: per-write streaming for the `newtron` action.**
  Today the `newtron` action's HTTP call captures the response
  body as one `StepOutput`. For Composer-style streaming, when
  the upstream newtron-server call admits `Accept: text/event-
  stream` (per newtron's streaming contract), forward the events
  to the newtrun event sink (per the bullet above). The
  per-substrate-operation visibility the operator-philosophy
  invariant #1 demands is then delivered as `newtrun event →
  frontend event` rather than `newtron event → newtcon event →
  frontend event` — one hop fewer.

### What stays in newtcon (the post-rebalance newtcon-server scope)

- **Observation History layer** — the SQLite polling store with
  `change_id` / `observation_id` / `gap_id`, the `source`
  classification engine, and the read-only HTTP surface that
  exposes them.
- **Report Bug layer** — the substrate-canonical body composition,
  the four templates, the `clipboard` / `direct_file` delivery
  modes. Depends on Observation History for recent-context.
- **Provenance layer** — read-only substrate inspection endpoints.
  Implemented as a thin proxy in front of newtron's intent /
  projection / changeset reads, with cross-reference fields
  (`changeset_url`, `intent_url`, `operation_url`) and stable
  retention semantics.
- **Teaching catalogs** — Manual-Mode Parity and Rehearsal.
  Static content; could be served by any HTTP server but ships
  with newtcon-server for convenience.
- **The Operations log** — long-lived per-operation history
  beyond a single newtrun run. This is what makes
  `operation_url` valid across time and is the substrate B.1's
  correlation engine writes to.

The rebalanced newtcon-server is, in line count and complexity,
something like 25-35 % of the currently-architected one. The web
frontend grows proportionally smaller too because most state-
changing screens become "render newtrun's `StepState` events" rather
than "render newtcon-server's bespoke per-surface state."

### What becomes harder (negative consequences)

1. **Two server hops for Composer-style work.** Today the
   architected path is `browser → newtcon-server → newtron-server →
   device`. The rebalanced path is `browser → newtrun-server →
   newtron-server → device`, plus `browser → newtcon-server` (for
   observation history and provenance reads). The frontend
   composes two backends instead of one. The cost is real but
   bounded: the two backends have non-overlapping responsibilities,
   so the composition is a routing concern, not a translation
   concern.

2. **Authority for the operator-philosophy invariants splits.**
   `docs/operator-philosophy.md` invariants #1 / #3 / #4 / #5
   (substrate exposure, show-before-do, why-mode) currently live
   in newtcon's contract surface and can be enforced PR-by-PR by
   the newtcon Critic. Post-rebalance, the equivalent enforcement
   for Composer-style work happens at newtrun's HTTP boundary —
   which is a different repo with a different review queue. The
   philosophy's binding scope narrows to newtcon-server's
   remaining surfaces; the cross-team coordination cost grows.

3. **Re-litigation risk on the upstream issues.** The newtrun
   extensions named above (HTTP-event subsystem, compose-and-run
   mode, per-write streaming forward) are non-trivial and put
   newtrun in a new posture (long-lived process, browser-facing).
   The newtron design team may push back. If newtrun rejects the
   extensions, newtcon-server has to re-absorb the responsibilities
   it just shed — and the cost of that re-absorption after a
   rebalance is higher than not rebalancing at all.

4. **Operator-philosophy invariant #2 (manual-mode parity) gets a
   new twist.** The teaching catalogs say "if newtcon is
   unavailable, the operator uses ssh + redis-cli directly." In
   the rebalanced architecture, the operator's primary write
   surface is newtrun-mediated, so unavailability of the **write
   surface** is now unavailability of `bin/newtrun` plus the
   newtrun server. The teaching catalog's "your own tools" pointer
   is unchanged; the invariant still binds. But the operator's
   day-to-day muscle memory shifts: instead of "log into newtcon
   web UI," it becomes "log into newtcon web UI for forensics,
   into newtrun for writes." That is a UX continuity loss the
   frontend must address (single sign-on, unified navigation).

5. **The cumulative-audit's drift signal would temporarily
   worsen.** Most contract PRs landed in the last 30 days defined
   surfaces in Bucket A. Retiring them is honest, but the
   implemented-vs-specified ratio (audit D1) recovers more slowly
   when "specified" shrinks alongside "implemented." The Drift
   Auditor's next cycle must read the rebalance as a deliberate
   correction, not as additional drift.

### What becomes true (positive consequences)

1. **The substrate boundary is honest.** newtron owns single-
   device automation; newtrun owns orchestration; newtcon owns
   observation-over-time + the operator's bug-filing affordance.
   No layer duplicates another.

2. **The implemented-vs-specified gap shrinks structurally.** The
   audit's D1 finding (2 % implementation ratio across 50
   endpoints) is partly a consequence of having 50 endpoints. After
   rebalance the endpoint count drops by ~60 %, and the surfaces
   that remain are tighter in scope.

3. **The philosophy's "make the operator more capable" test gets
   a clean line through newtrun.** Operators who use newtrun
   become capable of writing YAML scenarios that compose newtron
   primitives — that is the strongest form of "co-developer of
   the automation" the philosophy describes (`operator-
   philosophy.md` "Concrete success vision"). newtcon's frontend
   surfaces YAML scenarios as first-class operator artifacts
   ("here is the scenario this apply would have run; copy it for
   your records / your runbook / your CI"). The teaching surface
   for the orchestrator becomes the orchestrator's own substrate.

4. **The bug-report path becomes structurally tighter.** A bug
   report today must compose substrate from newtron + newtcon's
   operation store + newtcon's observation history. Post-
   rebalance, the operation store IS newtrun's `state.json` (or
   its HTTP equivalent); newtcon-server composes
   `state.json` + observation history + the operator's
   narrative. One source of operation truth instead of two.

5. **The "could be reimplemented in any HTTP-speaking language"
   property of newtcon-server (per `docs/architecture.md` §Why a
   Separate Process) becomes more visibly true.** The rebalanced
   newtcon-server is roughly "polling, SQLite, a few markdown
   templates, and HTTP" — that boundary is correct in any
   language.

### Risks the decision creates

1. **The rebalance is the most consequential ADR newtcon has
   produced. If wrong, it grounds the project for months.** The
   operator must agree with the substrate analysis (not just the
   conclusion) before this lands. The `Proposed` status is
   load-bearing.

2. **Bucket A's deprecation is justified by newtrun's *existing*
   capability, but the equivalent operator-philosophy-honoring
   frontend over newtrun does not yet exist.** There is a delivery
   gap between "newtcon's Composer is no longer being built" and
   "newtrun + the new frontend together meet the operator-
   philosophy bar." Operators who would have used the Composer
   have nothing in the interim. The rebalance is structurally
   right but operationally painful.

3. **The newtcon Architect / Critic / Drift Auditor team has been
   operating against the three-operator-surfaces charter for the
   entire session. The rebalance changes what they are auditing
   against.** `team-launch.md` §Completion criteria and the
   per-agent prompts will need updates to reflect the new
   surface set; otherwise the team will continue to spawn
   Composer / Inbox / Workbench work by default.

4. **The teaching catalogs (Manual-Mode Parity, Rehearsal) lose
   some of their gravitational pull when they no longer sit
   alongside a substantial write surface.** Operators who would
   have discovered them while using the Composer (the natural
   "I want to do this by hand" navigation) now have to discover
   them in a smaller, observation-focused newtcon. That is a
   discoverability loss that the frontend's information
   architecture must address.

## Alternatives considered

### Verdict 1 — Newtcon is uniquely positioned (rejected)

The argument was that the operator-philosophy invariants demand a
substrate-exposure presentation layer that newtrun's YAML +
`expect: jq` shape cannot deliver, and that the per-surface typed
contract in `API_CONTRACT.md` is itself the engine-level uniqueness.
That argument fails the substantive test. A typed contract is
*presentation*, not *engine*. The newtcon-server has nine surfaces
defined; of those, the engine-level work in seven of them (Composer,
Workbench, Inbox, Streaming, Provenance, Manual-Mode Parity,
Rehearsal) is either a thin proxy of newtron's HTTP API (translation
only) or static content (catalogs). The engine-level work that is
genuinely newtcon's lives in the polling/observation-history layer
and the bug-report composition that depends on it — two surfaces,
not nine. Calling that "uniquely positioned" against the seven other
surfaces overstates the engine contribution.

### Verdict 2 — Newtcon is largely duplicative; deprecate the server (rejected)

The argument was that the post-rebalance newtcon-server is so much
smaller that deleting it entirely and serving the remaining
substrate from newtrun's own filesystem (teaching catalogs as
markdown, observation history as a newtrun extension, bug reports as
a newtrun template) would be cleaner than maintaining two backends.
That argument fails because Observation History's polling layer,
`source` classification engine, and Report Bug's substrate-
canonical composition are non-trivial *and* outside newtrun's
design intent (newtrun runs scenarios and exits; the polling layer
is a long-lived daemon). Pushing them into newtrun would change
what newtrun is. Verdict 3 keeps the boundary clean.

### Considered alternatives during the analysis itself

- **Read the newtrun source first and architect newtcon against
  the gap.** This is what should have happened at session
  inception. It did not, and the cumulative cost is the ADR you
  are now reading. The corrective is to treat newtrun as a
  binding peer from this point forward — the Architect prompt
  is updated to include "verify the surface is not already in
  newtrun" as a check before authoring any new contract surface.
- **Keep the architected scope and accept the duplication as the
  cost of philosophy-discipline.** Rejected because the operator's
  question and the cumulative audit both signal that the team's
  capacity is the constraint, not the contract's expressive
  range. Duplication consumes capacity that could land
  observation-history (the surface that is genuinely newtcon-
  unique).
- **Pivot newtcon to "newtrun frontend only," delete newtcon-
  server entirely.** Rejected per Verdict 2's reasoning above —
  the polling / observation-history substrate is genuinely
  newtcon's, and serving it from newtrun's filesystem would
  either bloat newtrun's scope or scatter the substrate across
  ad-hoc files.

## Operator-philosophy invariants honored

- **Invariant #9 — Confidence and limits are explicit.** This ADR
  is the Architect's confidence statement on a question the
  Architect's prior work was structurally over-confident about.
  The verdict is hybrid (not "newtcon is great"); the deprecation
  list is concrete (not "we will rebalance somehow"); the risks
  are named (not glossed). The substrate (newtrun's actual
  capabilities) is cited at every claim.
- **Invariant #3 — The substrate is the teaching surface.** The
  ADR cites newtrun's HLD §1, §3, §7, the `pkg/newtrun/scenario.go`
  action enum, the `state.json` shape, and the `progress.go`
  reporter at the points where those substrates are load-bearing.
  A future reader can verify the verdict by re-reading the cited
  files.
- **Invariant #1 — No black boxes.** The verdict is reached by
  named-substrate reasoning, not by appeal to "newtcon should
  exist because we have invested in it" sunk-cost framing. Each
  surface in Bucket A is named, each duplicative primitive in
  newtrun is named, and the equivalence is shown end-to-end.
- **Capability litmus test.** Verdict 3 makes operators
  measurably more capable: they learn YAML scenarios (the
  long-lived authoring substrate of the orchestration layer),
  they learn the substrate via observation-history (the polling
  surface), and they learn the manual paths via the teaching
  catalogs. The architected newtcon would have taught them
  newtcon's UI primarily and the substrate secondarily —
  precisely the autopilot-grounds-pilots failure mode the
  philosophy rejects.

## Newtron / newtrun principles honored

- **`DESIGN_PRINCIPLES_NEWTRON.md` §8 — Scope Boundaries.** The
  verdict respects the three-tool partition: newtron per-device,
  newtrun multi-device orchestration, newtcon (post-rebalance)
  operator-facing observation. Bucket A's duplication was a
  scope-boundary violation in the architected newtcon (a fourth
  orchestrator layer on top of three already-bounded tools).
- **`DESIGN_PRINCIPLES_NEWTRON.md` §14 — Verify Your Writes;
  Observe Everything Else.** The verdict puts newtcon-server's
  remaining surface on the *observation* side of the line, which
  is where its long-lived process and persistent SQLite store
  belong. The write side stays in newtron + newtrun, where the
  per-device write opinions and the multi-device orchestration
  opinions already live.
- **`DESIGN_PRINCIPLES_NEWTRON.md` §46 — Wire Shape Mirrors
  Substrate.** Post-rebalance, every endpoint on the remaining
  newtcon-server surface mirrors a substrate that newtcon-server
  itself produces (observation snapshots, observation diffs,
  observation gaps, bug-report bodies). The mirror is honest
  because the substrate is locally owned.
- **`newtrun/hld.md` §1 — General-purpose orchestrator.**
  Promoting newtrun to the operator-facing write surface honors
  its own design intent — newtrun's HLD is explicit that it is
  "one orchestrator built on top of newtron — not the only one"
  and that other orchestrators "could be built for different
  purposes (production deployment, CI/CD pipelines, compliance
  auditing)." The verdict treats "operator-facing write
  surface" as exactly one of those purposes that newtrun's
  existing design accommodates with modest extension — rather
  than as a justification for a new orchestrator layer (which is
  what newtcon-server was unintentionally becoming).
