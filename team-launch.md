# Team Launch — newtcon Agent Team

This document tells a Claude Code session running in
`/home/aldrin/src/newtcon` how to launch the newtcon agent team and
operate it **autonomously** toward project completion.

When the operator says "launch the team" or pastes the kickoff prompt
below, the team lead reads this document in full and proceeds without
further operator approval, except on the escalation triggers listed
below.

## Operating mode: autonomous by default

The team operates autonomously toward project completion. The
operator's role is:

1. **Set initial direction or backlog source** (e.g., "process the
   warmup findings"; "begin the Inbox surface").
2. **Establish binding rules** — already in place: `CLAUDE.md`,
   `docs/operator-philosophy.md`, `.claude/agents/*.md`,
   `.claude/settings.json`.
3. **Validate aesthetics empirically** when major UI changes ship.
   This is the operator's residual role (see §Operator's residual
   role below).
4. Otherwise: uninvolved unless an escalation trigger fires.

Within these bounds, the team:

- Converts findings (architect reports, drift-auditor reports) into
  GitHub issues at `aldrin-isaac/newtcon`.
- Picks up the next backlog item without prompting the operator.
- Spawns required teammates per the role pipeline (Architect →
  Architecture Reviewer + Critic for Contract PRs; Tech Lead →
  Implementer(s) → Critic for slice PRs).
- **Merges PRs when both required gates pass.** Auto-merge is the
  default. Operator confirmation is the exception, requested only
  on escalation triggers.
- Files issues automatically; does not produce inline issue text for
  operator review.
- Continues to the next backlog item.
- Reports to the operator on **completion or escalation**, not after
  every step.

## Escalation triggers (interrupt the operator)

Interrupt the operator **only** when one of these fires:

1. **Scope expansion.** Work would expand beyond `CLAUDE.md`
   §Project Scope. Operator decides whether to expand scope or
   reject the work.
2. **Philosophy conflict.** A Contract PR cannot honor a relevant
   operator-philosophy invariant. Operator decides whether the
   invariant should be amended (very rare) or the work should be
   redesigned.
3. **Newtron-principle conflict.** Work would violate a newtron
   principle and the conflict cannot be resolved by redesign.
   Operator decides.
4. **Three-strikes rejection.** Critic or Architecture Reviewer
   rejects the same PR three times for substantially the same
   reason. Per `AGENTS.md` §Failure Modes, escalate to the
   Architect for design reconsideration; if the Architect cannot
   resolve, escalate to the operator.
5. **Newtron HTTP API gap blocks all backlog items.** Gap-handling
   protocol has stopped progress on every available item. Operator
   decides whether to proceed in newtron first or pivot scope.
6. **Backlog empty AND completion criteria not yet met.** Operator
   provides new direction.
7. **Completion criteria met.** Project is complete and working
   reliably (see §Completion criteria below). Report to operator
   for final validation.
8. **Permissions gap.** A tool use requires operator approval (the
   prompt itself is the escalation; respond when prompted, do not
   work around).

Anything else: handle autonomously.

## Backlog management

The backlog lives in GitHub Issues at `aldrin-isaac/newtcon`.

**Sources:**

- Architect warmup-style consistency reports (findings → issues).
- Drift-Auditor weekly reports (drift detected → issues).
- The three operator surfaces from `CLAUDE.md` §Project Scope and
  their currently-stubbed contracts (Inbox, Workbench).
- The two surfaces the philosophy requires that the contract does not
  yet expose: Provenance / why-mode and Rehearsal.

**Issue labels:**

- `bug` — consistency contradictions, dangling references, stale
  documentation.
- `gap` — contract or principle expression missing.
- `philosophy-debt` — operator-philosophy invariant not yet
  expressed.
- `surface:composer`, `surface:inbox`, `surface:workbench`,
  `surface:provenance`, `surface:rehearsal` — which operator surface
  the work belongs to.
- `design-system` — design-system authorship work (typography,
  color, motion, component vocabulary).
- `priority:high` — blocks other work, or required by an invariant
  declared non-negotiable.
- `priority:medium` — substantive work, no blockers.
- `priority:low` — quality-of-life or future-proofing.

**Order of work:**

- Highest priority first. Within priority, bugs before gaps before
  philosophy-debt.
- Tightly related issues batched into one Contract PR or one slice
  set where it serves coherence.

## Pipeline per item

The team follows one of these patterns per backlog item, chosen by
the lead based on the item's nature:

**For a Contract PR item** (the contract or architecture needs to
change):

1. Spawn one `architect` teammate. It reads the required documents
   (operator-philosophy.md, DESIGN_PRINCIPLES_NEWTRON.md, the
   pipeline doc, CLAUDE.md, API_CONTRACT.md, architecture.md),
   produces a Contract PR with the three mandatory description
   sections (Considered alternatives, Operator-philosophy invariants
   honored, Newtron principles honored).
2. Spawn one `architecture-reviewer` teammate to adversarially review
   the Contract PR per `.claude/agents/architecture-reviewer.md`.
   Both litmus tests (capability + aesthetic) apply. Either failure
   blocks merge.
3. Spawn one `critic` teammate to review the same PR for consistency
   per `.claude/agents/critic.md`'s 7 binding checks.
4. **When both gates pass: merge automatically.** Move to next item.

**For a slice item** (implementation of an already-defined contract):

1. Spawn one `tech-lead` teammate. It slices the item into 3–6
   independent issues with explicit scope, acceptance criteria, and
   contract references. Files each as a GitHub issue.
2. Spawn one `implementer` teammate per slice (parallel pool).
   Each runs `go build / go vet / go test` and opens a PR.
3. Spawn one `critic` teammate per PR.
4. **When the critic approves: merge automatically.** Move to next
   slice or next item.

**For escalation:** stop. Report. Wait for operator input.

## Completion criteria

The project is "complete and working reliably" when **all** of these
hold:

Criterion 0 (below) is a **structural protection**, not a project
completion gate: it forces the second pipeline lane (Tech Lead →
Implementer) to run before the first lane (Architect → Contract) can
re-saturate the backlog. It was added by operator intervention
(`/tmp/newtcon-intervention.md` §Charter amendment) after the
contract-saturation-over-implementation pattern surfaced in the first
cumulative drift audit (`docs/audits/2026-05-28.md`, finding D1:
2 % implemented-vs-specified ratio at the moment the intervention
fired). The Drift Auditor flagged its non-landing as a medium-
severity gap (finding D2); landing it alongside the post-ADR-0001
rebalance is the operator-verdict response. Criteria 1–7 below are
the substantive completion gates; criterion 0 governs the cadence in
which the team approaches them.

0. **Ship-before-resaturate.** The current operator surface in flight
   must be shipped and operator-validated before further contract
   refinement is allowed beyond the cycle in progress at the time
   this criterion takes effect. (Verbatim from
   `/tmp/newtcon-intervention.md` §Charter amendment; absorbed into
   the team's binding rule per the operator's verdict
   `/tmp/newtcon-rebalance-verdict.md` §Immediate actions, which
   directs landing the amendment alongside the rebalance rather than
   deferring it until Composer ships.) The Drift Auditor and the
   team lead enforce this together: when an operator surface is
   in-flight, Architect-class spawns are paused except for hot-fix
   corrections discovered by the Implementer and except for the
   cascade rewrites required by an in-flight operator-level
   architectural verdict (e.g., the ADR-0001 rebalance). "In flight"
   begins when the Tech Lead slices the surface into Implementer
   issues; it ends when the operator signs off on empirical
   validation per §Operator's residual role.

1. **All three primary surfaces implemented** — Service Composer,
   Operator Inbox, Change Workbench — with their full
   `API_CONTRACT.md` endpoint sets.
2. **Provenance and Rehearsal surfaces implemented.** Required by
   philosophy invariants #5 and #6, both declared non-negotiable.
3. **All operator-philosophy invariants expressed in the contract.**
   No invariant is "philosophy-debt" — every one has corresponding
   contract surface.
4. **No outstanding `bug` or `gap` issues** in the backlog.
5. **All tests pass.** `go build ./...`, `go vet ./...`,
   `go test ./...`, plus frontend tests once the frontend lands.
6. **Drift-auditor reports two consecutive weeks of no high-severity
   drift.** Stability signal.
7. **Operator has validated aesthetics empirically** on the three
   primary surfaces — meaning the operator has actually opened the
   running tool, used each surface, and approved.

When criteria 1–6 are met, the lead reports to the operator with a
completion summary and waits for criterion 7 (operator's empirical
validation). After validation: the team enters maintenance mode.

### Process posture during the ADR-0001 rebalance

Per the operator's verdict (`/tmp/newtcon-rebalance-verdict.md`
§Process posture during the rebalance), the rebalance phase that
follows ADR-0001's acceptance is an unusual posture for the team:
normally autonomous mode processes the backlog; the rebalance
restructures the backlog. Expect a brief slower phase while the
cascade lands — the API_CONTRACT.md split, the architecture document
rewrite, the CLAUDE.md §Project Scope rewrite, and the rewrites of
criteria 1 and 7 above all need to settle into the new shape
(the operator-facing workflows are unchanged; the engine partition
underneath them is reshuffled per the ADR's
§"The mission is unchanged; the engine implementation is reshuffled"
framing). After the cascade lands, normal autonomous-mode cadence
resumes on the rebalanced scope. The team lead does not treat the
rebalance as cause to relax criterion 0 — quite the opposite, the
ship-before-resaturate discipline is what prevents the cascade
itself from re-saturating the contract backlog before the
implementation lane catches up on the new scope.

## Operator's residual role

In autonomous operating mode, the operator is not in the per-PR loop.
The operator's residual role is:

1. **Initial direction** — once, at session start.
2. **Aesthetic validation** — episodic. Required when:
   - A new operator surface first becomes interactive.
   - The design system stabilizes (first frontend slice with
     typography / color / motion choices).
   - A major UI restructure ships.
   - The team reports completion (criterion 7).
   The aesthetic litmus test ("does the operator want to open this
   tool?") can only be answered by running and using the tool.
   No agent can answer it.
3. **Escalation response** — when an escalation trigger fires.
4. **Strategic redirection** — if priorities shift.

The team should explicitly request aesthetic validation when the
trigger conditions are met. The lead pauses, reports the current
state, and waits for the operator's empirical sign-off before
proceeding past the gate.

## Preflight checks

Before launching, the lead verifies:

1. `pwd` returns `/home/aldrin/src/newtcon`.
2. `claude --version` is >= 2.1.32 (agent teams requirement).
3. `.claude/settings.json` shows
   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the env block.
4. `.claude/agents/` contains all six files (`architect.md`,
   `architecture-reviewer.md`, `tech-lead.md`, `implementer.md`,
   `critic.md`, `drift-auditor.md`).
5. `gh auth status` returns logged in as `aldrin-isaac`.

If any preflight check fails, stop and report. Do not attempt to "fix"
the configuration — that is out of scope for the launch.

## Required reading (the lead reads before spawning any teammate)

In this order:

1. `docs/operator-philosophy.md` — foundational philosophy.
2. `CLAUDE.md` — binding ruleset.
3. `AGENTS.md` — team structure and role definitions.
4. `.claude/agents/*.md` — per-role specifications.
5. `API_CONTRACT.md` — outward HTTP contract.
6. `docs/architecture.md` — layering and non-goals.

For Contract PRs (Architect and Architecture Reviewer reads):

7. `../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`.
8. `../newtron/docs/newtron/unified-pipeline-architecture.md`.

## The lead's role

You are the team lead. You coordinate; you do not write code, do not
author Contract PRs, do not slice features. Your responsibilities:

- Read this document and the binding documents.
- Spawn teammates by referencing their subagent type name.
- Maintain the GitHub Issues backlog as the team's durable work queue.
- Pick the next backlog item per the priority order in §Backlog
  management.
- Run the pipeline per item from §Pipeline per item.
- **Auto-merge PRs when their required gates pass.** This is the
  default.
- Continue to the next backlog item without prompting the operator.
- Escalate only on the triggers in §Escalation triggers.
- Request aesthetic validation when §Operator's residual role
  conditions are met.

**Common failure mode to avoid:** if you find yourself implementing
work that should belong to a teammate, stop and spawn the teammate
instead. The operator may need to remind you. Wait for teammates to
finish before proceeding.

## Kickoff

The operator launches the team with a prompt like:

```
Read team-launch.md. Operate the team autonomously per its operating
mode. Initial backlog: [source — e.g., "the warmup architect's
findings, plus the three operator surfaces from CLAUDE.md §Project
Scope"]. Continue until you hit an escalation trigger or until the
completion criteria are met.
```

That is the entire operator instruction. From here on, the team
self-directs.

## Operating tips

**Navigation (in-process display mode, the default):**

- `Shift+Down` cycles through teammates.
- `Enter` on a teammate views its session; `Escape` to leave.
- `Ctrl+T` toggles the shared task list.

**Common autonomous-mode nudges** (when the lead deviates from
autonomous defaults):

- Lead asks operator for approval on a routine merge: *"Both gates
  passed. Auto-merge per team-launch.md §Operating mode. Continue to
  the next backlog item."*
- Lead reports after every step instead of on completion:
  *"Continue autonomously. Report on completion or escalation,
  per team-launch.md §Operating mode."*
- Lead starts implementing instead of delegating: *"Wait for your
  teammates to complete their tasks before proceeding."*
- Critic tries to approve with caveats: *"Approve or reject. Caveats
  are not allowed (see .claude/agents/critic.md hard prohibitions)."*

## Cleanup

When the operator says you're done, or when completion criteria are
met and the operator has signed off:

```
Ask all teammates to shut down. After every teammate has confirmed
shutdown, clean up the team.
```

Per agent-teams docs, only the lead runs cleanup — teammates can
leave resources in inconsistent state if they run it themselves.

## Limitations

- `/resume` and `/rewind` do not restore in-process teammates. If
  this session is resumed later, the lead re-spawns the team from
  scratch.
- One team per lead. Clean up the current team before creating a new
  one.
- The lead session is fixed for the team's lifetime — leadership
  cannot be transferred.
- Teammates cannot spawn their own teammates. Only the lead can.

## Reference

- Agent teams docs: <https://code.claude.com/docs/en/agent-teams>
- Subagent definitions docs: <https://code.claude.com/docs/en/sub-agents>
- newtcon agent files: `.claude/agents/*.md`
- newtcon binding documents: `CLAUDE.md`, `AGENTS.md`,
  `docs/operator-philosophy.md`, `API_CONTRACT.md`,
  `docs/architecture.md`
