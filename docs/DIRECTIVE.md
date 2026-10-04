# newtcon — binding directive

**Status:** active. Supersedes the 8-surface contract paradigm (Composer / Workbench / Inbox / Provenance / Rehearsal / Manual-Parity / Observation-History / Report-Bug) previously documented in `API_CONTRACT.md`, `team-launch.md`, and `docs/architecture.md`. Those documents are kept for history but are not authoritative for current work. **Read this document before acting on any of them.**

Set by operator 2026-05-30 → 2026-05-31. Will evolve as the operator further directs.

---

## Mission

Ship features useful to a real network operator quickly. Conform to `../newtron/docs/editing-guidelines.md` and `../newtron/docs/ai-instructions.md`. Stay faithful to `../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`.

## The operator workflow loop (the basics)

newtcon's UI is one integrated workspace around the operator's network-lifecycle workflow loop, in order:

1. **Author specs** — services, IP VPNs, MAC VPNs, QoS policies, filters, route policies, prefix lists, device profiles, zones, platforms.
2. **Define topology + bind authored intent** — add nodes, draw links, bind services to interfaces.
3. **Visualize the topology + mapped intent** — see the network you've composed.
4. **Deploy topology** (whole or in parts) — spawn the actual VMs / wire the links (newtlab, reached through `bin/newt-server`).
5. **Detect drift** — actual device CONFIG_DB vs device-local intent and topology-level intent.
6. **Reconcile drift** — restore device to intent.

Everything else newtcon could surface (per-device CONFIG_DB browser, BGP/EVPN status, raw intent tree, etc.) is **inside** this loop — accessible by drilling into nodes from the topology view, not as separate top-level pages.

## Slice plan against the 6-step loop

| # | Slice | Step | State |
|---|-------|------|-------|
| 0 | File `newtlab-server` gap on newtron repo | gates 4 | ✅ newtron#53 |
| 1 | Multi-spec workspace at `/` (read all 10 spec types) | 1 | ✅ PR #116 |
| 2 | Per-spec detail drawer (full newtron payload) | 1 | ✅ PR #117 |
| 3 | Topology view + node inspector (every per-device read) | 2, 3 | ✅ PR #118 |
| 4 | Drift indicator + drift detail panel | 5 | ✅ drift counts on topology SVG (PR #131); device drawer Drift tab |
| 5 | Reconcile flow (preview → atomic apply) | 6 | ✅ device drawer Drift tab: Reconcile preview → apply |
| 6 | Spec authoring + editing (POST/PUT/DELETE for each kind) | 1 → write | ✅ PR #131 (pending-changes queue + Apply All / Discard); schema-driven forms since newtron #240 |
| 7 | Topology editor + interface→service binding | 2 → write | ✅ PRs #131 / #140 / #141 (port-mode + service binding; primitive composition kept in Specs tab) |
| 8 | Deploy from UI (newtlab-server lifecycle + SSE phases) | 4 | ✅ unified-substrate phases 1–4: PRs #136 (deploy modal) / #137 (status badges) / #138 (lifecycle inspector) / #139 (Lab tab retired, Provision moves to toolbar) |

The 6-step loop closes end-to-end through the Topology tab today: operator authors specs in Specs → adds devices + links in Topology → binds services to interfaces → brings up as lab → watches booting → running badges → reconciles drift per-device.

## Settled product decisions

Operator decisions made after the loop shipped. Each is binding until the operator changes it; a later decision overrides an earlier one.

**Where things are authored**
- Specs are authored in **Specs**; Topology only *applies* them. Services are composed in Specs and applied to interfaces in Topology. Topology never authors primitives (prefix lists, route policies, …).
- Nodes are created in Specs and *added* to the topology from a drop-down of defined nodes. The canvas does not create or delete node specs.
- A port's mode (routed / bridged access / bridged trunk) is set in Topology. Routed ports take a predefined service. Bridged ports take predefined VLANs.
- Scope (network / zone / node) is picked first on a form, and the scope instance comes from a drop-down. Zone and node overrides nest under their network-level record. "Add override" starts from the parent's values.
- References to other specs (prefix lists, route policies, VPNs, filters, …) are drop-downs of defined specs, never free-form text.

**How changes happen**
- **Every change queues.** That includes spec edits, sub-rules, topology changes, port configuration and SSH login. Apply All runs the queue in order after an "are you sure?" confirmation. Discard only clears the browser-side queue and never touches newtron. A partial failure leaves the failed items queued and reports per item. Each queued item shows its request URL, scope included, alongside its body.
- **Do no harm.** Undo is a roll *forward* to a past state, made from the inverse each change carries with it. It is never a rollback to a savepoint. Server-side history is not newtron's job.
- Offer only meaningful transitions. Actions that make no sense in the current state are disabled: no Destroy before Deploy, no Provision before Deploy, no delete while bindings exist.

**Topology views**
- Three views over one topology spec: **Spec** (the only place to add or remove nodes and links), **Lab** (newtlab Deploy / Provision / Destroy, using newtlab's own verbs), and **Physical** (Provision only).
- Colours: blue = in the spec but not actuated, green = actuated and matching the spec, red = actuated and down, violet = drift. Lab drift and physical drift are independent of each other.
- newtlab only bootstraps devices. Once a lab VM is running it is operated exactly like a physical device.
- A network's name is its single identity, for lab and physical alike. Newtron needs only the name, never a directory path.

**Engine fidelity**
- Spec forms render from newtron's schema. newtcon carries no per-kind knowledge of what a spec means. Report limitations rather than silently dropping a capability.
- Use each engine's own vocabulary: newtron's "user groups" (not "roles") and newtlab's lifecycle verbs.
- When newtron is missing something, write the request and wait for it. Don't add temporary bridges in newtcon.

**UX bar**
- Delight the operator: simple yet powerful, never a tedious graphical CLI. No gimmicks: every visual element must earn its place with an operator reason.
- Dark is the default theme.
- A fresh clone must work with default settings and no security setup. Auth, TLS and audit are optional for newcomers. The operator's own dev environment still runs with all of them enabled.

## Capability discipline

**Maximize what newtron / newtrun / newtlab offers. Leave no capability inaccessible.**

For every newtron HTTP endpoint exposed in `pkg/newtron/api/handler.go` (and the sibling engines' handlers), surface either:
- A direct affordance in the UI (read or write), or
- A click-through reachable from a parent affordance.

Drilling deep is allowed; hiding is not.

## Lead discipline

**Lead never guesses about newtron / newtrun / newtlab.** When in doubt, read both docs and code before sending agents anywhere or making design claims. The lead is the primary executor — agents are tools for genuinely large work, not delegation by default.

Authoritative sources for the three peer tools (all under `/home/aldrin/src/newtron/`):

| Tool | Code | Docs |
|------|------|------|
| **newtron** | `pkg/newtron/`, `cmd/newtron-server/`, `cmd/newtron/` | `docs/newtron/` (hld, lld, api, intents, unified-pipeline-architecture) |
| **newtrun** | `pkg/newtrun/`, `cmd/newtrun-server/`, `cmd/newtrun/` | `docs/newtrun/` (hld, lld, api, howto) |
| **newtlab** | `pkg/newtlab/`, `cmd/newtlab/`, `cmd/newtlink/`, exposed via aggregated `bin/newt-server` | `docs/newtlab/` (hld, lld, howto) and `docs/newt-server.md` for the aggregated routing |
| **Principles** | — | `docs/DESIGN_PRINCIPLES_NEWTRON.md` |

The lead reads `pkg/newtron/api/handler.go` `buildMux()` directly when uncertain about which endpoints exist or what they do.

## Team posture

| Role | Posture | Activation |
|------|---------|------------|
| **Lead (me)** | primary executor; integrator + smoke-tester for all PRs | always |
| **Implementer** | spawned only when scope justifies (~2+ hr work); tight briefs (~80 lines, not 200) | per-slice, on demand |
| **Architect** | dormant unless a real contract change is needed | rare |
| **Critic** | spawned only on Architect/Contract PRs; not on slice PRs | rare |
| **Tech Lead** | dormant | reactivate when project scale warrants |
| **Architecture Reviewer** | dormant | reactivate for genuine architecture decisions |
| **Drift Auditor** | dormant | reactivate when scale or operator-validation gap surfaces drift |

**Lead smoke test is the gate for slice PRs.** No Critic ceremony unless something looks off. The lead's discipline replaces the ceremony.

## Quality gates per slice (lead-applied)

1. `go build`, `go vet`, `go test ./... -count=1` clean.
2. `npm run typecheck`, `npm run build`, `npm test` clean.
3. Live smoke test against newtron at `:18080` — every new endpoint returns real data.
4. Vocabulary scan: `grep -irE 'substrate|surface|service-first|pipeline-stage' web/dist/` returns empty. Source comments also clean (operators can view-source).
5. PR title + body accurately describe what the code does.
6. Lead merges directly; pulls main; starts next slice.

## Vocabulary discipline (binding)

**Every operator-visible word evaluated through the lens of a network operator.** No project-internal vocabulary in: page text, URL paths, link hover-text, DevTools inspector identifiers (CSS classes, JS variable names visible to operators), error message strings, README user-facing sections, or any doc the operator-facing page links to.

**Operator-domain words** for the workflow concepts: services, IP VPNs, MAC VPNs, QoS policies, filters, route policies, prefix lists, device profiles, zones, platforms, topology, nodes, interfaces, VLANs, VRFs, ACLs, BGP, EVPN, LAGs, neighbors, drift, reconcile, ChangeSet (operator may know this from newtron, treat as borderline), CONFIG_DB (SONiC-domain — fine).

**Project-internal terms** that must NOT appear in operator-visible places: substrate, surface, slice, milestone, pipeline, wire-shape, render stage, deliver stage, service-first, device-first.

Wire-shape error kind identifiers (`newtron_unavailable`, `validation_failure`, `precondition_failure`, `drift_refusal`, `internal`) stay in the wire contract per editing-guidelines §42 — rendering translates them to operator-domain language.

Full discipline in `~/.claude/projects/-home-aldrin-src-newtcon/memory/feedback_operator_language_lens.md`.

## Port assignments (current)

| Service | Default port |
|---------|--------------|
| `newtron-server` | `127.0.0.1:18080` |
| `newtrun-server` | `127.0.0.1:18081` |
| `newtcon-server` | `--addr` default `127.0.0.1:8080`; the live dev instance runs on `0.0.0.0:8095` (HTTPS, `--auth-required`) and the smoke suite targets it |
| newtlab | served by the aggregated `bin/newt-server` (newtron#53, closed) |

## What's archived / superseded

- `API_CONTRACT.md`: kept for history. The 8-surface contract (Composer / Inbox / Workbench / Provenance / Rehearsal / Manual-Parity / Observation-History / Report-Bug) is superseded. **For UI work, the binding interface is newtron's actual HTTP API as defined in `pkg/newtron/api/handler.go`.** Use `API_CONTRACT.md` only as historical reference for shapes that may inform future work.
- `team-launch.md`: kept for history. The completion criteria and team-launch sequencing are superseded by this directive.
- `docs/architecture.md`: kept for history. The 3-process layering description is accurate but framed for the 8-surface paradigm.
- The substrate-vocabulary cascade (PRs #98–#102): kept for history. The "bridge" pattern was the wrong remedy for operator-facing prose — operator-visible text must remove project terms entirely, not bridge them.

## What's still binding

- `docs/operator-philosophy.md` — the 9 invariants. (§Vocabulary section is contributor-only; don't link to it from operator-facing pages.)
- `../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md` — the principles all three tools derive from.
- `../newtron/docs/editing-guidelines.md` — documentation craft.
- `../newtron/docs/ai-instructions.md` — universal behavioral directives.
- `docs/adr/0001-scope-justification-vs-newtrun.md` — the 3-tool rebalance (its verdict: don't duplicate newtrun). Its "what stays in newtcon" list (observation-history store, Report Bug, Rehearsal catalogs, operations log) predates this directive and is **not** a build list.
- `docs/adr/0002-frontend-framework.md` — vanilla HTML + TypeScript-as-typed-ES-modules (no bundler).
- The "newtron API Consumption Rule" in `CLAUDE.md` — all newtron HTTP traffic via `internal/newtronc/`, no Go imports of newtron, no subprocess.
- The build convention: `go build -o bin/newtcon-server ./cmd/newtcon-server`.

## How to verify you're acting on the current directive

If you (agent or lead) find yourself reading or citing:
- `API_CONTRACT.md` sections about Composer / Inbox / Workbench / Provenance / Rehearsal / Manual-Parity → STOP. Read this directive instead.
- `team-launch.md` completion criteria → STOP. Read this directive instead.
- "8 surfaces" framing anywhere → STOP. The framing is 1 workspace, 6-step workflow loop.
- "Tech Lead spawn" or "Architecture Reviewer spawn" → STOP unless this directive's team-posture table explicitly authorizes.

If you (operator) want to evolve the directive, edit this file directly. The lead reads it before every slice cycle.
