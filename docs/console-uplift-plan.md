# Console uplift program — consolidation, structure, beauty

**Status:** proposed (operator review). On approval, Phase 0–1 slices are
filed as GitHub issues (the working backlog); later phases are filed at each
phase boundary, not up front — a plan pretending to know slice-level detail
five phases out would be lying.

**Origin:** a full-codebase critique (2026-07-18) after ~380 merged PRs. The
verdict in one line: *an unusually disciplined machine wearing plain clothes.*
The invisible architecture (single newtron boundary, pure-module + test
culture, the staging model, operator language) is the project's best asset
and this program must not damage it. What needs work is **consolidation**
(one god-file, six hand-rolled chip families, three step-parsers),
**interaction structure** (no deep links, overlay drawer fighting the canvas,
transport-flavored error headlines), and **visual confidence** (one-volume
gray-on-gray, wireframe topology aesthetic, no dark theme).

This is a **program plan**: phases, slices, gates, and sequencing rationale.
It deliberately does not carry pixel-level design decisions — those are made
slice-by-slice with screenshots at the review gate.

---

## The contract: ALWAYS leave it better than you found it

Binding rules for every slice in this program, on top of the DIRECTIVE's
quality gates:

1. **Green in, green out.** `go test`, `npm run typecheck && npm test`, and
   the smoke suite pass before and after every slice. A refactor slice with
   a red smoke does not merge — no exceptions, no "will fix in follow-up."
2. **Move-only means move-only.** Extraction slices (Phase 1) may not change
   behavior. The diff must be reviewable as relocation: no logic edits, no
   renames-plus-tweaks. Behavior changes ride separate slices.
3. **No half-migrations** (the holistic-consistency rule). When a pattern
   changes — chips, error headlines, tokens — every conforming site converts
   in the same PR. A codebase with two chip systems is worse than one with
   six accidental ones, because it *looks* intentional.
4. **Ratchets only tighten.** Phase 0 records baseline metrics (app.ts LOC,
   ad-hoc chip classes, hardcoded colors). A checked-in script asserts each
   metric never regresses; slices may only lower a ratchet's ceiling.
5. **Screenshots are part of the diff** for every visually observable slice
   — captured with the Phase-0 script, attached to the PR, compared against
   the visual baseline. Beauty changes are reviewed as images, not prose.
6. **The map stays true.** CLAUDE.md's file-ownership map is updated in the
   same PR as any structural change.
7. **Stop points between phases.** Each phase ends with operator review of
   the accumulated result before the next phase's issues are filed. The
   program has no momentum of its own — it re-earns scope at every boundary.

## Non-goals (rejected on principle, not deferred)

- **No framework adoption.** ADR-0002 (vanilla TS + tsc) stands. Everything
  below is achievable with the current stack; the pure-module discipline is
  the "framework."
- **No rewrite of the staging/queue model** — it is load-bearing and good.
- **No server-side history migration** in this program (see 5.2 — honesty
  labeling only; a server-side design goes to roadmap.md).
- **No mobile-first work, no multi-tenant** (operator-philosophy).
- **No visual redesign of the Specs forms** beyond primitives + tokens —
  schema-driven forms are newtron's vocabulary and stay plain.

---

## Phase 0 — Safety net (before touching anything)

*Rationale: Phases 1–4 are large mechanical diffs and visual changes. Both
need regression instruments that don't currently exist as one-command tools.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 0.1 | **Smoke runner** — `npm run smoke`: executes every `web/test/smoke/*.smoke.mjs` sequentially with env plumbing (`NEWTCON_URL`, creds, NET/DEVICE), per-smoke pass/fail/skip summary, non-zero exit on failure. Update `docs/smoke-suite.md`. | One command runs all 30 smokes against `:8095`; deployed-gated smokes skip cleanly when the lab is down. | S |
| 0.2 | **Visual baseline** — `web/scripts/screenshots.mjs`: captures a canonical set (Specs, Topology spec/lab views, drawer × 3 tabs, Apply-All modal, Permissions, Audit) to `web/test/visual-baseline/` (gitignored) with a `--compare` mode producing side-by-side HTML. | Baseline set captured on main; compare mode produces a reviewable page. | S |
| 0.3 | **Ratchet script** — `web/scripts/ratchet.mjs` run from `npm test`: asserts `app.ts` LOC ≤ baseline, count of `-chip` class *families* ≤ baseline, raw hex colors in `workspace.css` ≤ baseline. Ceilings live in a checked-in JSON that slices edit downward. | `npm test` fails if any ratchet regresses. | S |

## Phase 1 — Consolidation (code health)

*Rationale: every later phase lands code into these modules. Splitting first
means beauty work never touches a 6,829-line file. Order within the phase is
lowest-entanglement first, so the extraction pattern is proven cheap before
the two hard files move.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 1.1 | **`views/` skeleton + `dom.ts`** — extract `el()`/`renderValue` helpers; create `views/` with a mount registry; move the already-modular History + Audit mounts behind it. | app.ts shrinks; pattern established; smokes green. | S |
| 1.2 | **Extract Specs view** → `views/specs/` (subnav, facet panels, General section, detail drawer forms glue). | Move-only; specs smokes green; ratchet lowered. | M |
| 1.3 | **Extract device drawer** → `views/drawer/` (header, Interfaces tab + IRB section + live status, State tab, Spec/Drift/History tabs). Highest-risk move; lands as 2–3 stacked move-only PRs (interfaces / state / rest). | Move-only; drawer smokes green (iface-table, iface-status, irb-interfaces, state-tables, resource-lens…); ratchet lowered. | L |
| 1.4 | **Extract Topology view** → `views/topology/` (canvas render, viewport, toolbar, filters, palette, drawers glue). | Move-only; topology smokes green; ratchet lowered. | L |
| 1.5 | **Device-model layer** — `device-model.ts`: one fetch bundle (topology + platform + live reads) exposing selectors (ports, SVIs, bindings, services, links). `device-interfaces`, `device-resources`, `irb-interfaces` become selectors over it; the three independent step-parsers collapse to one. | Single source of step-parsing; all three consumers migrated in one PR (rule 3); unit tests keep their fixtures. | M |

**Phase exit:** `app.ts` ≤ ~800 lines (entry + tab dispatch only); zero
behavior change (0.2 compare ≈ baseline); operator review.

## Phase 2 — Primitives & interaction structure

*Rationale: shared primitives make the theme phase mechanical instead of
archaeological, and the structural UX changes (router, docked inspector)
reshape layout before the topology phase invests in the canvas.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 2.1 | **UI primitives** — `ui.ts` + `design-system/components.css`: `chip`, `status-dot`, `kv-grid`, `data-table`, `disclosure-section`, `inline-form`. One PR **per primitive**, each converting *every* existing instance (six chip families → one chip with variants, etc.). | Per-primitive: all call sites migrated, ratchet (chip families) lowered, screenshots attached. | M total |
| 2.2 | **Operator error taxonomy** — `render-error.ts` headlines become operator meanings: *Refused* (409/conflict), *Not ready* (precondition), *Engine unreachable* (transport), *Invalid input* (400), *Not permitted* (401/403) — verbatim upstream detail always beneath. | All error surfaces use the taxonomy; unit tests updated; no transport words in headlines. | S |
| 2.3 | **Toast discipline** — stack below the header bar, cap visible count, collapse repeats. | Toasts never overlap header controls (0.2 screenshot proof). | S |
| 2.4 | **Hash router** — `#/{net}/{view}` + view params (device drawer, spec facet, topology selection). Load restores state; back/forward works; network switcher updates the hash. | Deep-link to a device drawer survives refresh; smoke added. | M |
| 2.5 | **Docked inspector** — ≥1400px viewports: drawer becomes a grid pane beside the canvas (overlay retained below threshold). Deletes the `body.drawer-open` MutationObserver hack and the canvas-shrink CSS. | Canvas + inspector coexist without hacks; drawer smokes green in both modes; screenshots reviewed. | M/L |

**Phase exit:** operator review of interaction feel; decide 2.5 threshold.

## Phase 3 — Theme & type (beauty foundation)

*Rationale: tokens → primitives (done) → theme is the cheap path. Dark
theme before topology work so the canvas identity is designed against both
themes from the start.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 3.1 | **Hardcoded-color audit** — every raw hex/rgba in `workspace.css` becomes a token reference (ratchet → 0). | Zero raw colors outside `design-system/`. | S |
| 3.2 | **Dark theme** — full dark token set under `[data-theme="dark"]`; default follows `prefers-color-scheme`; toggle in the sidebar footer; persisted per browser. | Every view + modal + canvas legible in both themes (0.2 captures both); no unthemed surface. | M |
| 3.3 | **Type & numerals** — self-hosted mono with identity (JetBrains Mono, OFL) for device names/counters; `font-variant-numeric: tabular-nums` wherever numbers change live (rates, counters, badges); scale polish. | No layout shift when live numbers tick; license file vendored. | S |
| 3.4 | **Status-presence pass** — saturation/contrast tuning so danger/drift/warning carry visual weight against calmer neutrals; `:focus-visible` states everywhere interactive. | Screenshot review against baseline; WCAG AA contrast spot-checks. | S |

**Phase exit:** operator picks the default theme; visual baseline re-captured
as the new reference.

## Phase 4 — Topology identity (the crown)

*Rationale: this is where newtcon stops looking like a wireframe. Every
slice here reads data the console already has (or gets in one bulk call) —
no newtron changes required. Ordered so static truth lands before live
animation.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 4.1 | **Node rendering v2** — filled role-glyph cards (leaf/spine/host silhouettes), soft shadows; **dashed outline reserved strictly for spec-only** (palette #210 semantics, promoted to aesthetic law). | Both themes; all 5 palette states distinguishable; screenshots. | M |
| 4.2 | **Link truth** — solid = LLDP-verified (bulk per device via `/db/APPL_DB/LLDP_ENTRY_TABLE`, one call), dashed = intent-only; color by underlay session state (`bgp/check` per device); thickness by configured speed. | A mis-cabled or down link is visually distinct from a healthy one; legend added; smoke asserts class mapping. | M |
| 4.3 | **Lenses** — extend the filter-chip row: *VNI lens* (halo every member port of a chosen VLAN — RCA-051 made visible), *underlay lens* (session overlay), *drift lens*. Pure lens state like `topology-filters`. | Lens on/off leaves layout stable; unit tests for lens derivations. | M |
| 4.4 | **Live layer** — utilization shimmer/heat from `RATES` (bulk `/db/COUNTERS_DB` per device), polled only while the tab is visible *and* a live lens is on; deploy SSE drives boot animation on nodes. | Poll cost bounded (one call per device per tick, tab-visible only); reduced-motion respected. | M |
| 4.5 | **Focus mode + fabric-health strip** — select node → dim non-neighbors (Esc restores); keyboard nav between nodes; header strip aggregating bgp/check + drift + lab state per network. | Strip visible on every tab; focus mode smoke. | M |

**Phase exit:** the screenshot-worthy milestone; operator review of the
whole canvas against Phase-0 baseline.

## Phase 5 — Verbs & honesty (polish)

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 5.1 | **Cmd-K verbs** — palette stages actions, not just navigation: "apply *service* on *device:port*", "create VLAN *N* on *device*", "deploy *network*" — each landing in the staging queue (never direct apply). | Verbs stage into the queue with the same preview/undo path; smoke. | M |
| 5.2 | **History honesty** — History tab labeled "this browser"; link to Audit for the server-side record. A server-side history design (correlating Apply-All batches with newtron audit events) goes to `roadmap.md` as `future`. | No operator can mistake local history for shared truth. | S |

---

## Sequencing summary & dependencies

```
0.1→0.2→0.3 ─┬─ 1.1 → 1.2 → 1.3 → 1.4 → 1.5 ──┬─ 2.1 → {2.2, 2.3} 
             │                                  ├─ 2.4        
             │                                  └─ 2.5 ──┐    
             │                       3.1 → 3.2 → 3.3 → 3.4│   (3.x needs 2.1)
             │                                            ▼
             └────────────────────────────► 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 5.x
                (4.x needs 1.4 + 2.1 + 3.2)
```

Rough sizing: S ≈ one focused session, M ≈ one long session, L ≈ split
across stacked PRs. ~26 slices; Phases 0–1 are the commitment, everything
later re-earns scope at its phase boundary.

## Metrics the program is accountable to

| Metric | Baseline (2026-07-18) | Target | Final (2026-07-19, program complete) |
|---|---|---|---|
| `app.ts` lines | 6,829 (of 18,427 frontend) | ≤ 800 | **49** (ratchet ceiling) |
| Chip class families | 9 (measured by 0.3 — the critique's grep undercounted) | 1 | **1** (ceiling 0 extra) |
| Independent topology-step parsers | 3 | 1 | **1** (device-steps.ts) |
| Raw colors in `workspace.css` | 53 (recorded by 0.3) | 0 | **0** (comment-aware counter, ceiling 0) |
| Themes | 1 (light) | 2, both first-class | **2** (data-theme; system-follow default; per-browser pin) |
| Deep-linkable views | 0 | all primary views | **all** (#/{net}/{view} + facet/detail/device params) |
| Unit tests / smokes | 695 / 30 | only up | **770 / 40** |

## Phase 6 — Composition (operator-commissioned, 2026-07-19)

*From the fresh-lens critique: fewer, denser, calmer surfaces on the
now-solid bones. Issues #444–#451.*

| # | Slice | Definition of done | Size |
|---|-------|--------------------|------|
| 6.1 | **Canvas command bar** — view+lens+zones+health in one compact bar; the canvas is the home. | One bar; no vertical regression; smokes updated. | M |
| 6.2 | **Drawer mini-header** — device + palette state pinned across tabs + scroll. | Pinned through scroll/tab-switch; smoke. | S |
| 6.3 | **Cmd-K argument pickers** — click-through chips; typing still works. | Verb stageable mouse-only; smoke. | M |
| 6.4 | **Engine posture surface** — auth/audit/reachability honest in one place. | Posture visible without 404-tripping; smoke. | S |
| 6.5 | **Mono display identity** — JetBrains Mono brand + headings. | Both themes reviewed. | S |
| 6.6 | **Canvas composition** — arced parallel links, heavier switch cards, status in card footer. | Screenshots; palette/link smokes green. | M |
| 6.7 | **Springy drawer motion** — dock/undock/open with one engineered spring; reduced-motion instant. | No jank; reduced-motion respected. | S |
| 6.8 | **Zone tinting** — barely-visible topographic zone regions. | Screenshots; no pointer interference. | S |

## Program status — Phases 0–5 COMPLETE (2026-07-19); Phase 6 in progress

All five phases landed: 0.1–0.3 (instruments), 1.1–1.5 (extractions),
2.1–2.5 (primitives, error taxonomy, toasts, hash router, docked
inspector), 3.1–3.4 (color audit, dark theme, JetBrains Mono +
numerals, status presence), 4.1–4.5 (node cards, link truth, lenses,
live layer, focus + fabric-health strip), 5.1–5.2 (Cmd-K verbs, history
honesty). PRs #381–#435. Two operator decisions remain from phase
exits: the default theme (currently system-follow) and the Phase-4
canvas review (compare.html in web/test/visual-baseline/).
