# newtcon Agent Team

This file defines the binding team structure for agent-driven development of
newtcon. The team is designed to operate with minimal operator involvement
while preventing design drift, scope creep, and erosion of the principles in
[`CLAUDE.md`](CLAUDE.md).

## Implementation

This document is the **authoritative** role specification. The harness
wiring that makes the roles operational lives in `.claude/`:

- `.claude/settings.json` — enables
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (required for Claude Code's
  agent-teams feature; requires Claude Code v2.1.32 or later).
- `.claude/agents/architect.md`
- `.claude/agents/tech-lead.md`
- `.claude/agents/implementer.md`
- `.claude/agents/critic.md`
- `.claude/agents/drift-auditor.md`

Each agent file is a Claude Code subagent definition: frontmatter
(`name`, `description`, `tools`, `model`) plus a body that is **appended**
to the teammate's system prompt. When the team lead spawns a teammate, it
references the agent by name — e.g., "spawn a critic teammate to review
PR #N", "spawn an implementer teammate for issue #M".

The agent files are **supplementary** to this document, not replacements.
When this document and an agent file disagree, this document wins, and the
agent file must be updated. Agent files are concise extracts intended for
the teammate's prompt budget; full role context lives here.

The Claude Code harness auto-generates the team config and shared task list
at `~/.claude/teams/{team-name}/config.json` and
`~/.claude/tasks/{team-name}/`. These are NOT authored by hand — the
harness manages them and overwrites edits on the next state update.

Reference: <https://code.claude.com/docs/en/agent-teams>.

## Roles

| Role | Model | Cardinality | Invocation | Owns |
|------|-------|-------------|------------|------|
| **Architect** | Opus (`claude-opus-4-7`) | 1 (singleton, on-demand) | API/architecture decisions; new contract endpoints | `CLAUDE.md`, `API_CONTRACT.md`, `docs/architecture.md`, ADRs |
| **Tech Lead** | Opus (`claude-opus-4-7`) | 1 (per-feature) | Feature kickoff | Slicing features into independent issues; acceptance criteria per slice |
| **Implementer** | Sonnet (`claude-sonnet-4-6`) | N (parallel pool) | Per-slice issue | Code + tests + docs for one slice end-to-end |
| **Critic** | Opus (`claude-opus-4-7`) | 1 (mandatory, per-PR) | Every PR before merge | Design drift review, principle compliance, scope check |
| **Drift Auditor** | Opus (`claude-opus-4-7`) | 1 (weekly cron) | Weekly | Cumulative diff scan, systemic drift detection, operator report |

No PM role. No separate Test role. No "Frontend Engineer" and "Backend Engineer"
splits (slices cross the stack).

## Why This Structure

Three antipatterns that this structure avoids by construction:

- **PM-as-coordinator.** Human PMs work because they carry continuity. Agents
  don't carry anything across sessions; only files do. The Tech Lead does the
  real coordination work (slicing + acceptance criteria), and that work
  produces durable artifacts. Status reporting and roadmap are absent because
  there are no stakeholders to report to during agent execution.
- **Separate test agents.** Tests get written by the agent that wrote the code,
  in the same slice. A separate test agent produces either mirror-tests (no
  signal) or spec-tests that generate triage noise. Test quality is enforced
  by the Critic, not by staffing a test role.
- **Symmetric Opus/Sonnet pairing per role.** Pairing two models on the same
  role creates incoherence — they have different judgment thresholds. Each
  role is single-staffed with the right model for the work.

## Per-Role Specifications

### Architect (Opus)

**Invoked when:** a new endpoint is proposed; a public API surface changes;
`CLAUDE.md` or `API_CONTRACT.md` need editing; a design question crosses two
or more slices.

**Inputs:** the proposing issue or PR; the current `CLAUDE.md`,
`API_CONTRACT.md`, and relevant newtron authoritative docs.

**Outputs:** a PR that edits `CLAUDE.md`, `API_CONTRACT.md`, or
`docs/architecture.md` (or all three). Architect PRs are a separate PR class
and may not include implementation code in the same PR.

**Out of scope:** implementing endpoints; writing tests; reviewing
implementation PRs for code quality.

### Tech Lead (Opus)

**Invoked when:** an operator surface or feature is ready to start
(Architect has finalized contract additions).

**Inputs:** the Architect's contract additions; the feature description.

**Outputs:** a set of GitHub issues, one per slice, each containing:
- Slice scope (what files, what endpoints, what UI components).
- Acceptance criteria (what tests must pass; what contract endpoints
  must respond correctly).
- Explicit dependencies between slices (so parallel work is safe).
- Pointer to the relevant `API_CONTRACT.md` section.

A slice is "good" when an Implementer can complete it without consulting any
agent or human — only the issue, `CLAUDE.md`, `API_CONTRACT.md`, and the
codebase.

**Out of scope:** writing code; reviewing PRs.

### Implementer (Sonnet)

**Invoked when:** a sliced issue is in the ready queue.

**Inputs:** the issue (slice scope + acceptance criteria), `CLAUDE.md`,
`API_CONTRACT.md`, the existing codebase.

**Outputs:** one PR per slice containing:
- Code (handlers, types, client wrappers as required).
- Tests (unit + contract tests as required by acceptance criteria).
- Doc updates (only within the slice's scope — e.g., handler-level comments).

**Forbidden:**
- Editing `CLAUDE.md`, `API_CONTRACT.md`, or `docs/architecture.md`.
- Adding endpoints not in `API_CONTRACT.md`.
- Go imports of any newtron package (newtron is consumed over HTTP only).
- Adding newtron to `go.mod` via `require` or `replace`.
- Subprocess invocation of `bin/newtron` or any newtron binary.
- HTTP traffic to newtron-server originating outside `internal/newtronc/`.
- Implementing out-of-scope features (see `CLAUDE.md` §Project Scope).
- Working around newtron HTTP API gaps; the Gap-Handling Protocol applies.

**Parallelism:** multiple Implementers run concurrently on different slices.
Coordination is through the `API_CONTRACT.md` and the issue queue, not through
agent-to-agent communication.

### Critic (Opus)

**Invoked when:** every PR opens. Mandatory gate; no PR merges without Critic
approval.

**Inputs:** the PR diff, `CLAUDE.md`, `AGENTS.md`, `API_CONTRACT.md`,
`docs/architecture.md`, relevant newtron principles.

**Checks (binding):**
1. **newtron consumption rule:** no Go imports of any newtron package
   anywhere in newtcon. All newtron interaction is HTTP, originating only
   from `internal/newtronc/`. No newtron in `go.mod`. No `bin/newtron`
   subprocess calls.
2. **Scope:** the PR implements its assigned slice and nothing else. Drive-by
   refactors, "while I'm here" cleanups, or out-of-scope features → reject.
3. **Contract compliance:** if the PR adds endpoints, they exist in
   `API_CONTRACT.md`. If contract was changed, the change went through the
   Architect (separate PR).
4. **Principle compliance:** the PR respects `CLAUDE.md` §Design Principles —
   service-first, pipeline-aware, preview-before-commit, reference-aware
   removals, operator-honest errors, no hidden state.
5. **File ownership:** new code lives in the file the ownership map dictates.
6. **Tests:** acceptance criteria from the issue are exercised by tests in the
   PR.
7. **No prohibited patterns:** no copy-pasted newtron internal types, no
   direct Redis access to newtron's databases, no vendored newtron source.

**Output:** approval with no comments, OR rejection with a structured comment
listing which checks failed and why. The Critic does not propose
implementation fixes — that is the Implementer's job on the next iteration.

**The Critic is the firewall.** Without it, agents will silently relax
principles over time. With it, every drift attempt produces a documented
rejection that the Implementer must address.

### Drift Auditor (Opus)

**Invoked when:** weekly, via cron (Sunday 00:00 UTC by default).

**Inputs:** the week's merged diff (all PRs since last audit), `CLAUDE.md`,
`AGENTS.md`, `API_CONTRACT.md`, `docs/architecture.md`.

**Checks (cumulative drift, not per-PR):**
- Have implementation patterns diverged across handlers? (e.g., three different
  ways of doing the same thing in three handler files.)
- Have undocumented conventions emerged? (e.g., a state-management pattern
  used in 5 places that's not in any doc.)
- Have principles eroded? (e.g., a hidden cache that violates "no hidden state"
  but slipped past the Critic.)
- Have newtron HTTP API gaps accumulated as silent workarounds rather than
  filed newtron issues?
- Is the test surface keeping pace with the endpoint surface?

**Output:** a structured report committed to `docs/audits/YYYY-MM-DD.md`. The
report has three sections:
- **Drift detected** (each entry: pattern, files affected, severity).
- **Recommended actions** (each entry: who acts, what they do).
- **No-drift confirmations** (sanity check — what was checked and found clean).

The Drift Auditor does not file PRs to fix drift — that produces a Tech Lead
slicing task. The audit is informational; the slicing turns it into work.

**This is the closest thing to operator-as-PM that the team has.** It catches
the systemic drift the per-PR Critic cannot see. 15 minutes of operator time
per week to read the audit is the recommended (but not required) involvement.

## Coordination Protocol

**Agents do not communicate with each other directly.** All coordination is
through durable artifacts:

- **`CLAUDE.md`** — binding rules.
- **`API_CONTRACT.md`** — the API bus. All endpoint definitions live here.
- **`AGENTS.md`** — team structure (this file).
- **GitHub issues** — work queue. Tech Lead writes, Implementers consume.
- **PR comments** — Critic's structured rejections.
- **`docs/audits/`** — Drift Auditor reports.

An Implementer who needs information from another Implementer in flight should
treat that as a slicing error and report it (the slices weren't independent).
The Tech Lead re-slices.

## PR Classes

PRs are typed. Each type has different requirements:

| Class | Editable Files | Requires Critic? | Requires Architect? |
|-------|----------------|-------------------|---------------------|
| **Implementation** | `internal/`, `cmd/`, `web/`, tests | Yes | No |
| **Contract** | `API_CONTRACT.md` | Yes | Yes (must be authored by Architect) |
| **Architecture** | `CLAUDE.md`, `AGENTS.md`, `docs/architecture.md` | Yes | Yes (Architect-authored) |
| **Audit** | `docs/audits/` | No | No (auto-committed by Drift Auditor) |

A single PR may not cross classes. An Implementer PR that tries to edit
`API_CONTRACT.md` is rejected by the Critic on principle, regardless of the
edit's merit.

## Failure Modes and Recovery

**Implementer can't complete the slice:**
- If blocked by a newtron HTTP API gap → Gap-Handling Protocol; close as blocked.
- If blocked by ambiguous acceptance criteria → reject the slice back to Tech
  Lead with a structured "needs clarification" comment.
- If blocked by a dependency on another in-flight slice → reject as slicing
  error; Tech Lead re-slices.

**Critic rejects three times on the same PR:**
- Implementer halts. The slice is escalated to the Architect for review of the
  underlying design.

**Drift Auditor reports severe drift:**
- Operator decides whether to spawn corrective slicing or to revise
  `CLAUDE.md` to acknowledge new patterns as intentional.

**Architect proposes a contract change that breaks an in-flight slice:**
- Tech Lead pauses dependent slices until the contract PR merges, then
  re-issues the slices.

## Operator Involvement

The minimum operator involvement to keep the team healthy:

- **Weekly:** read the Drift Auditor's report (~15 min).
- **Monthly:** scan `API_CONTRACT.md` diff for surprise growth (~10 min).
- **On-demand:** confirm `--newtron-url` and credentials when newtron-server
  endpoints, ports, or auth model changes.

Everything else is autonomous.
