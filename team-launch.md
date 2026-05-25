# Team Launch — newtcon Agent Team

This document tells a Claude Code session running in
`/home/aldrin/src/newtcon` how to launch the newtcon agent team and
start a first task. **Read it in full before doing anything.** It is
meant to be opened by the main agent (the team lead) at the start of
the first run.

When the user says "launch the team" or pastes one of the prompts
below, the team lead follows the corresponding scenario.

## Preflight checks

Run these before launching:

1. `pwd` — must be `/home/aldrin/src/newtcon`.
2. `claude --version` — must be >= 2.1.32 (agent teams require this).
3. Confirm `.claude/settings.json` shows
   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the env block.
4. Confirm `.claude/agents/` contains six files:
   `architect.md`, `architecture-reviewer.md`, `tech-lead.md`,
   `implementer.md`, `critic.md`, `drift-auditor.md`.

If any preflight check fails, stop and report to the operator. Do not
attempt to "fix" the configuration — that is out of scope for the
launch.

## Required reading (the team lead reads these before spawning any teammate)

In this order:

1. **`docs/operator-philosophy.md`** — newtcon's foundational
   philosophy ("intelligent network, intelligent operator"). The
   automation must make the operator MORE capable, not less.
   Beautiful, elegant, simple AND powerful.
2. **`CLAUDE.md`** — binding ruleset: scope, design principles, file
   ownership, gap-handling protocol, allowed commands.
3. **`AGENTS.md`** — team structure, role definitions, PR classes,
   coordination protocol.
4. **`.claude/agents/*.md`** — concise per-role specifications that
   each teammate will receive as supplementary system prompt.
5. **`API_CONTRACT.md`** — the outward HTTP contract.
6. **`docs/architecture.md`** — layering and non-goals.

For Architect or Architecture Reviewer work, additionally:

7. **`../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`** — newtron's
   authoritative principles.
8. **`../newtron/docs/newtron/unified-pipeline-architecture.md`** —
   the pipeline newtcon's UI surfaces (Intent → Replay → Render →
   Deliver → Verify).

## Your role as the team lead

You coordinate. You do not write code, do not author Contract PRs,
do not slice features. Your job is to:

- Read this document and the binding documents.
- Spawn teammates by referencing their subagent type name (e.g.,
  "spawn an architect teammate," "spawn an implementer teammate for
  slice #N").
- Wait for teammates to finish before acting yourself.
- Report progress to the operator after each major step.
- Enforce the team's gates: do not advance to merge until both Critic
  and Architecture Reviewer (where required) have approved.
- Clean up the team when the operator says you're done.

**Common failure mode to avoid:** if you find yourself implementing
work that should belong to a teammate, stop and spawn the teammate
instead. The operator may need to remind you. Wait for teammates to
finish before proceeding.

## Launch scenarios

The operator chooses one. Variants are listed in order of increasing
scope.

### Scenario A: Warm-up — single agent, no code (recommended first run)

A dry run that verifies the agent team configuration works without
touching code or PRs. Spawns one architect teammate and asks for a
consistency report.

```
Spawn one architect teammate. Have it read docs/operator-philosophy.md,
CLAUDE.md, API_CONTRACT.md, docs/architecture.md, and AGENTS.md end-to-
end, plus ../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md. Then produce a
short consistency report (under 300 words):

- Anything in API_CONTRACT.md that contradicts CLAUDE.md.
- Anything in CLAUDE.md that references files that don't exist.
- Anything missing in API_CONTRACT.md given the three operator surfaces
  (Service Composer, Inbox, Workbench).
- Any operator-philosophy invariant that the current contracts do not
  honor.
- Any newtron design principle (cited by section) that the current
  newtcon design does not derive from cleanly.

Single teammate, single output, no implementation, no PRs.
```

Use this to verify the team launches cleanly before any code is at
stake.

### Scenario B: First vertical slice — `GET /api/services`

The contract for `GET /api/services` is in the seed; no Architect
Contract PR is needed for this task. The Architect's role is
sanity-check, not authoring.

```
Today's task is the first vertical slice of the Service Composer:
implement GET /api/services per API_CONTRACT.md.

Run the pipeline in this order. Wait for each step to complete before
starting the next.

1. Spawn one architect teammate. Have it read docs/operator-philosophy.md,
   CLAUDE.md, API_CONTRACT.md §GET /api/services, and docs/architecture.md.
   Produce a short readiness report:
   - Is the contract complete enough to slice?
   - Are there contradictions with CLAUDE.md or the operator philosophy?
   - Are there gaps that need a Contract PR before slicing begins?
   If gaps exist, the architect produces the Contract PR (which then
   needs Architecture Reviewer + Critic approval before slicing).
   Otherwise the architect issues an "OK to slice" signal.

2. Once the architect signals OK, spawn one tech-lead teammate. Have it
   slice GET /api/services into 3–5 independent issues with explicit
   scope, acceptance criteria, and contract references. Produce the
   issue text inline (do not file via `gh issue create` for this first
   run — we want to review the slicing first).

3. Spawn one implementer teammate per slice the tech-lead produces.
   Each implementer works only on its slice and follows the
   prohibitions in .claude/agents/implementer.md. Each implementer
   produces a diff (PR-ready) and runs go build / go vet / go test.

4. After each implementer produces a diff, spawn one critic teammate
   to review against .claude/agents/critic.md's 7 binding checks. The
   critic either approves or requests changes with structured per-check
   feedback. Block merge if any check fails.

Report progress to me after each major step (architect done, tech-lead
done, each implementer done, each critic review done). Do not auto-
merge — the operator confirms before any PR merges, for this first
run.

Wait for teammates to finish before acting yourself.
```

### Scenario C: New operator surface (Inbox or Workbench)

When the contract for the surface does NOT yet exist in
`API_CONTRACT.md` (the Inbox and Workbench endpoints are currently
stubbed), an Architect Contract PR is mandatory before slicing.

```
Today's task: add the [Inbox | Workbench] surface to newtcon.

Run the pipeline in this order. Wait for each step to complete before
starting the next.

1. Spawn one architect teammate. Required reading:
   - docs/operator-philosophy.md (apply both litmus tests).
   - ../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md (cite relevant sections).
   - ../newtron/docs/newtron/unified-pipeline-architecture.md.
   - CLAUDE.md, API_CONTRACT.md, docs/architecture.md.
   Produce a Contract PR adding the endpoints for the [Inbox |
   Workbench] surface to API_CONTRACT.md. The PR description must
   include three mandatory sections: Considered alternatives,
   Operator-philosophy invariants honored, Newtron principles honored.

2. Spawn one architecture-reviewer teammate to adversarially review
   the architect's PR per .claude/agents/architecture-reviewer.md. Both
   the capability litmus test and the aesthetic litmus test apply.
   Block merge if either fails.

3. Spawn one critic teammate to review the same PR for consistency
   per .claude/agents/critic.md's 7 binding checks. Both reviewer
   gates must pass before the Contract PR merges.

4. Once the Contract PR merges, spawn one tech-lead teammate to slice
   the new endpoints into independent issues.

5. Spawn one implementer teammate per slice.

6. Spawn one critic teammate per implementer PR for review.

Report progress to me after each major step. Do not auto-merge — the
operator confirms each merge.

Wait for teammates to finish before acting yourself.
```

## Operating tips

**Navigation (in-process display mode, the default):**

- `Shift+Down` cycles through teammates. After the last teammate,
  wraps back to you (the lead).
- Press `Enter` on a teammate to view its session; `Escape` to leave.
- `Ctrl+T` toggles the shared task list.

**Talking to a specific teammate:** focus on them with `Shift+Down`,
then type a message. Useful when one teammate needs a nudge or
correction.

**Common nudges:**

- If the lead starts implementing instead of delegating:
  *"Wait for your teammates to complete their tasks before proceeding."*
- If the critic tries to approve with caveats:
  *"Approve or reject. Caveats are not allowed (see
  .claude/agents/critic.md hard prohibitions)."*
- If an implementer tries to work around a newtron API gap:
  *"Follow the Gap-Handling Protocol in CLAUDE.md. Stop
  implementation, file a newtron issue, mark the newtcon issue
  blocked."*
- If the architect tries to ship a Contract PR without the three
  mandatory sections: *"Your PR is missing the [section name]
  section. The Architecture Reviewer will reject. Revise before
  requesting review."*

**Things to escalate to the operator (do not handle autonomously):**

- Any tool use the permissions allowlist does not cover (will prompt
  automatically; surface to operator if unclear).
- A teammate proposes work outside `CLAUDE.md` §Project Scope.
- A Critic or Architecture Reviewer rejects three times on the same
  PR for the same reason (escalate to the Architect for design
  reconsideration per AGENTS.md §Failure Modes).
- The operator philosophy or any newtron principle appears to be in
  tension with what the operator is asking for.

## Cleanup

When the operator says you're done:

```
Ask all teammates to shut down. After every teammate has confirmed
shutdown, clean up the team.
```

Per the agent-teams docs, only the lead should run cleanup —
teammates can leave resources in inconsistent state if they run it
themselves.

## Limitations to be aware of

- `/resume` and `/rewind` do not restore in-process teammates. If
  this session is resumed later, the lead will need to re-spawn the
  team from scratch.
- One team per lead. To run a fresh team, clean up the current one
  first.
- The lead session is fixed for the team's lifetime — leadership
  cannot be transferred to another session.
- Teammates cannot spawn their own teammates. Only the lead can.

## Reference

- Agent teams docs:
  <https://code.claude.com/docs/en/agent-teams>
- Subagent definitions docs: <https://code.claude.com/docs/en/sub-agents>
- newtcon agent files: `.claude/agents/*.md`
- newtcon binding documents: `CLAUDE.md`, `AGENTS.md`,
  `docs/operator-philosophy.md`, `API_CONTRACT.md`,
  `docs/architecture.md`
