# Architecture Decision Records (ADRs)

This directory holds newtcon's Architecture Decision Records. An ADR
captures a single architectural decision — what was decided, why, and
what the consequences are — at the moment the decision was taken. ADRs
are append-only history: once merged, they are not edited except to
mark them superseded.

For binding rules on ADR authorship, see [`../../CLAUDE.md`](../../CLAUDE.md).
For the team structure and PR classes, see [`../../AGENTS.md`](../../AGENTS.md).
For the overall architecture this directory records decisions about, see
[`../architecture.md`](../architecture.md).

## When to write an ADR

Write an ADR when the decision:

- Affects a boundary in the architecture (e.g., frontend framework,
  build pipeline, persistence strategy).
- Selects a design-system primitive (typography, color palette, motion
  vocabulary, component primitives — see [`../../AGENTS.md`](../../AGENTS.md)
  §Architect, design-system responsibility).
- Resolves a question that crossed two or more slices and would
  otherwise be re-litigated.
- Documents the rationale for accepting a non-obvious constraint
  (e.g., why a particular dependency was chosen over plausible
  alternatives).

Do not write an ADR for:

- Routine implementation choices internal to a single slice.
- API contract additions — those live in [`../../API_CONTRACT.md`](../../API_CONTRACT.md)
  as Contract-class PRs.
- Process or team-structure changes — those edit
  [`../../AGENTS.md`](../../AGENTS.md) as Architecture-class PRs.

## Authorship

ADRs are authored by the Architect (see [`../../AGENTS.md`](../../AGENTS.md)
§Architect). An ADR is an Architecture-class PR: it requires both Critic
and Architecture Reviewer approval before merge, and it may not be mixed
with edits to `CLAUDE.md`, `API_CONTRACT.md`, or `docs/architecture.md`
in the same PR.

The PR description for an ADR carries the same three mandatory sections
required of every Architect-authored PR:

- **Considered alternatives** — at least two real alternatives with
  non-strawman reasoning.
- **Operator-philosophy invariants honored** — citations from
  [`../operator-philosophy.md`](../operator-philosophy.md).
- **Newtron principles honored** — citations from
  `../../../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`.

## Naming convention

ADR filenames follow `NNNN-kebab-title.md`, where:

- `NNNN` is a zero-padded four-digit sequential number, allocated by
  the Architect at PR-open time. Numbers are never reused; if an ADR
  is withdrawn before merge, its number stays retired.
- `kebab-title` is a short, lowercase, hyphen-separated slug that
  describes the decision in five words or fewer.

Examples:

- `0001-frontend-framework.md`
- `0002-color-palette-and-semantics.md`
- `0017-motion-vocabulary.md`

The number must be greater than every existing ADR's number in this
directory at the moment the PR is opened. Concurrent ADR PRs are
resolved by the second Architect rebasing onto the latest number.

## Required sections

Every ADR file contains, in this order:

1. **Title** — `# NNNN. Title in Sentence Case` as the first line.
2. **Status** — one of `Proposed`, `Accepted`, `Superseded by NNNN`,
   `Withdrawn`. New ADRs land as `Accepted` (the PR review *is* the
   acceptance gate; `Proposed` is reserved for ADRs that need
   operator-side approval before being binding).
3. **Date** — RFC 3339 date the ADR was merged (filled in at merge,
   not at PR open).
4. **Context** — what situation prompted the decision; what
   constraints applied; what was previously unknown or contested.
   This section is the teaching surface — a future reader must be able
   to understand *why this decision was needed* without external
   context. Per [`../operator-philosophy.md`](../operator-philosophy.md)
   §Fractal application, ADRs are teaching documents, not compliance
   records.
5. **Decision** — what was decided, stated as a directive. "We will
   use Svelte for the frontend," not "Svelte seems reasonable."
6. **Consequences** — what becomes true (positive), what becomes
   harder (negative), what is now constrained that previously was
   free. Honest about trade-offs; an ADR with no negative
   consequences is suspect.
7. **Alternatives considered** (optional but strongly encouraged) —
   what was considered and rejected, with non-strawman reasoning.
   This section may reference or summarize the PR description's
   "Considered alternatives" section, but the ADR itself is the
   durable record.

Additional sections (e.g., **References**, **Implementation notes**,
**Migration**) may be added when the decision warrants them. They
follow the required sections.

## Superseding an ADR

To replace a previous decision, author a new ADR that begins with:

```
Status: Accepted
Supersedes: NNNN
```

Then edit the superseded ADR — and only that field — to:

```
Status: Superseded by MMMM
```

Editing a superseded ADR's body is forbidden; the superseding ADR
carries the new reasoning. This is the one exception to the
append-only rule, and it lives in the status field alone.
