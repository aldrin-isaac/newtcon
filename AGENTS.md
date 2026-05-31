# newtcon Agent Team

> **BINDING DIRECTIVE: read `docs/DIRECTIVE.md` for current team posture.**
>
> The 2026-05-30 recalibration left most agent roles dormant. This file lists the roles and their current status. Active role prompts live at `.claude/agents/{role}.md`.

## Current posture (per `docs/DIRECTIVE.md`)

| Role | Status | When spawned |
|------|--------|--------------|
| **Lead** (the Claude Code session at the keyboard) | always active | every cycle |
| **Implementer** | active | when a slice has ~2+ hours of focused work |
| **Critic** | conditionally active | on Architect / Contract PRs only — never on slice PRs |
| **Architect** | dormant | rare — only when a genuine contract change is needed |
| **Architecture Reviewer** | dormant | reactivate for genuine architecture decisions |
| **Tech Lead** | dormant | over-engineered at MVP scale; lead slices directly |
| **Drift Auditor** | dormant | reactivate when project scale warrants OR operator-validation surfaces drift |

The lead smoke-test (build + tests + live curl against newtron at `:18080` + vocabulary scan) is the gate for slice PRs. Critic ceremony does not apply to slice PRs.

## Active role specs

Read the prompts directly:

- **`.claude/agents/implementer.md`** — the active role; implements one slice end-to-end (code + tests + smoke-test confirmation). Brief is supplied by the lead per slice.
- **`.claude/agents/critic.md`** — conditionally active for Architect / Contract PRs only.

## Dormant role specs (kept for reactivation)

- `.claude/agents/architect.md`
- `.claude/agents/architecture-reviewer.md`
- `.claude/agents/tech-lead.md`
- `.claude/agents/drift-auditor.md`

Each dormant prompt carries a banner instructing the agent to return immediately if spawned by mistake. If a real need to reactivate emerges, the lead updates `docs/DIRECTIVE.md` first and then spawns.

## Lead workflow per slice

1. Read `docs/DIRECTIVE.md` (slice plan, current state).
2. Choose the next slice from the plan.
3. Decide: lead-direct (small) vs implementer-spawn (~2+ hr).
4. If implementer: write a tight brief (~80 lines, not 200), spawn in background.
5. When implementer returns OR lead-direct work completes:
   - `go build` / `go test` / `npm run typecheck` / `npm run build` / `npm test` all clean.
   - Live smoke test against newtron at `:18080`.
   - Vocabulary scan: `grep -irE 'substrate|surface|service-first|pipeline-stage' web/dist/` and source comments — both clean.
   - PR title + body accurately describe what changed.
6. Squash-merge directly; pull main; start next slice.

## Authoritative governance

- `docs/DIRECTIVE.md` — what to build, in what order, with what discipline
- `CLAUDE.md` — binding repo rules (boundary, build, file ownership)
- `docs/operator-philosophy.md` — the 9 invariants
- `docs/adr/*.md` — accepted decisions
