# newtcon Project — Claude Code Instructions

newtcon is the operator-facing web console for newtron. This file is the
binding ruleset for every agent that touches this repo.

**Definitions in this document are specifications, not suggestions.** When a
section defines a term with precise meaning (e.g., "public API consumption,"
"design drift"), that definition is binding — it overrides any natural-language
interpretation of the phrase.

## Project Scope

newtcon delivers exactly three operator surfaces, in this order:

1. **Service Composer** — pick a service spec, pick N target interfaces across
   M nodes, preview the resulting ChangeSets, commit atomically. Same surface
   handles apply, refresh, and remove. See [`API_CONTRACT.md`](API_CONTRACT.md).
2. **Operator Inbox** — actionable cards for drift, convergence stragglers,
   partial operations, reference-count warnings, reconcile-due signals.
3. **Change Workbench** — staged batches of intents with dry-run preview, atomic
   commit, stash, and revert.

**Out of scope** (do not implement, do not stub, do not propose):

- Topology editing / blueprint drawing
- Device-form configurators (per-device tabs with form fields for every CONFIG_DB table)
- Status dashboards with green/red lights as the primary surface
- Authentication/authorization (deferred until operator surfaces are validated)
- Multi-tenant features
- Mobile-first layouts

If a feature is not one of the three surfaces above, it does not belong in
newtcon. Out-of-scope work is rejected at PR review.

## Reference Documents

Authoritative documents live in the newtron repo. Read these before making
design decisions in unfamiliar areas:

| Document | Path (in `../newtron/`) | Purpose |
|----------|-------------------------|---------|
| newtron HLD | `docs/newtron/hld.md` | Architecture, intent model, Redis interaction |
| newtron LLD | `docs/newtron/lld.md` | Type definitions, method signatures, package structure |
| Pipeline Reference | `docs/newtron/unified-pipeline-architecture.md` | Intent → Replay → Render → Deliver |
| AI Instructions | `docs/ai-instructions.md` | Universal behavioral directives |
| DESIGN_PRINCIPLES | `docs/DESIGN_PRINCIPLES_NEWTRON.md` | The principles newtcon UX surfaces |

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

When implementing a slice, an agent may discover that newtron's HTTP API
does not expose required functionality. The agent MUST:

1. **Stop implementing the feature.** Do not work around the gap.
2. **Open a newtron issue** (in newtron's repo, not newtcon's) titled
   `newtron HTTP API gap: <domain-term>`. The body describes the gap in
   domain terms (operator-facing intent), not implementation terms, and
   proposes the HTTP shape newtron should expose.
3. **Mark the newtcon issue blocked** with a link to the newtron issue.
4. **Move to the next available slice.**

Forbidden under any circumstance:

- Adding a Go import of any newtron package.
- Adding a `replace` directive for newtron in `go.mod`.
- Vendoring newtron source into newtcon.
- Re-implementing newtron logic in newtcon "as a workaround."
- Calling `bin/newtron` (or any newtron binary) as a subprocess.
- Reading newtron's CONFIG_DB / APP_DB / etc. directly via a Redis client.

If the gap blocks all available slices, halt and notify the operator via the
Drift Auditor's next report.

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

These principles are derived from newtron's DESIGN_PRINCIPLES, adapted for the
operator-UI surface. They are binding on every agent.

### Service-First, Not Device-First

The operator's mental verbs are about services. The primary navigation is by
service, not by device. Device-centric views exist only as a secondary lens
when the operator drills down from a service instance.

Apstra and similar tools are device-first. newtcon is not.

### Pipeline-Aware UX

Every operation the UI initiates traces through newtron's pipeline
(Intent → Replay → Render → Deliver → Verify). The UI surfaces the stage of
each in-flight operation, not just a binary success/failure.

A "verify" stage that hasn't completed is shown as in-progress, not as success.
A "deliver" stage that succeeded with verify pending is not "done."

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

### No Hidden State

The UI displays what newtron's intent/projection actually says. Caches in the
UI server are explicit, time-bounded, and visible (e.g., "data as of 12:04:21").
Stale data is never rendered as current.

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
