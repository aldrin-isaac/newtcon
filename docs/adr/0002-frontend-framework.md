# 0002. Frontend framework selection

Status: Accepted
Date: 2026-05-29
Decision: newtcon's browser frontend is built as **vanilla HTML + TypeScript-as-typed-ES-modules**, with no SPA framework, no client-side framework runtime, and no bundler. The TypeScript compiler (`tsc`) is the only build dependency; output is plain ES modules served as static files by `newtcon-server`.

## Context

[`docs/architecture.md`](../architecture.md) §Frontend framework
selection (lines 576–596) deferred the framework choice to "the first
frontend slice." The first operator-facing webpage milestone —
sliced as newtcon#103 (this ADR), newtcon#104 (scaffold),
newtcon#105 (read-only services-listing page), newtcon#106
(aesthetic polish + design-system seed) — cashes that deferral. The
framework choice is binding on every subsequent `web/` slice; the
scaffolding, page, and design-system slices are blocked on it.

### The immediate need is small; the trajectory is larger

newtcon#105 implements one read-only page that fetches `GET /api/services`
on the same origin and renders a list. The response shape is six
fields per row; the page has no client-side state beyond the in-flight
fetch. By any conventional framework-selection rubric, this page is
under the minimum scale at which a framework pays for itself.

The eventual operator workflows — Service Composer, Operator Inbox,
Change Workbench — are stateful, interactive, and consume Server-Sent
Events from `newtrun-server` carrying `EventStepProgress` with
verbatim `sonic.DeviceOp` substrate (per
[`docs/architecture.md`](../architecture.md) §Artifact 2 and newtron's
`DESIGN_PRINCIPLES_NEWTRON.md` §46). They are heavier surfaces. A
framework selection that optimizes only for the read-only page may be
under-fit; one that optimizes only for the future workflows may be
over-fit at the read-only-page scale.

Per [ADR-0001](0001-scope-justification-vs-newtrun.md) §Consequences
"What stays in newtcon," the post-rebalance frontend grows
*proportionally smaller* than the pre-rebalance architecture
anticipated: "most state-changing screens become 'render
newtrun's `StepState` events' rather than 'render newtcon-server's
bespoke per-surface state.'" The Composer/Inbox/Workbench surfaces
are dominantly substrate-rendering, not substrate-authoring. That
trajectory bears on the framework choice: a renderer of typed
substrate from two HTTP backends is a smaller frontend than a
framework-managed application with client-side state.

### The operator-named baseline

The operator's 2026-05-27 intervention
(`/tmp/newtcon-intervention.md` §Charter amendment, absorbed into
`team-launch.md` §Completion criteria 0 as the ship-before-resaturate
rule) named **minimum-viable HTML + vanilla JS or whatever ships
fastest** as the fastest-ship path:

> "No frontend framework debate. The Tech Lead picks. Minimum-viable
> HTML + vanilla JS or whatever ships fastest. SPA-framework decisions
> can wait."

Per the Tech Lead's framing in newtcon#103, any framework choice
heavier than vanilla must defend against vanilla on substantive
grounds — build/scaffold cost, aesthetic discipline,
extensibility, operator-capability. Per
[`CLAUDE.md`](../../CLAUDE.md) §Survey adjacent tools and
[ADR-0001](0001-scope-justification-vs-newtrun.md), the
peer-substrate survey discipline applies here too: anything
heavier than vanilla must clear the bar of *what does it add that
the operator's stated baseline does not?*

### Selection criteria from `docs/architecture.md`

[`docs/architecture.md`](../architecture.md) §Frontend framework
selection lists four criteria the choice must satisfy:

1. **Bundle size.** Operator console, not consumer app — small
   dependency surface preferred.
2. **TypeScript first-class.** Both `newtcon-server`'s and
   `newtrun-server`'s HTTP APIs are typed; the frontend must consume
   typed shapes without runtime parsing.
3. **Component model that supports the three operator workflows and
   the four observation-side surfaces without exotic patterns.**
4. **Two-backend composition ergonomics.** The frontend will hold
   typed clients for both `newtcon-server`'s API and `newtrun-server`'s
   API and compose them in the workflow layer.

The decision below evaluates the chosen approach against each.

### The operator-philosophy lens

Three invariants from
[`docs/operator-philosophy.md`](../operator-philosophy.md) bear most
directly on framework choice:

- **#1 — No black boxes.** Every automated action is fully
  inspectable. Applied to framework choice: the rendered output must
  be readable HTML the operator can inspect. View-source must make
  sense. Framework-generated DOM that obscures the relationship
  between source and rendered page is a black box at the presentation
  layer.
- **#3 — The substrate is the teaching surface.** The framework must
  not invent client-side substrate that does not exist on the wire.
  Per `DESIGN_PRINCIPLES_NEWTRON.md` §46, the wire shape mirrors the
  substrate; the frontend's job is to render that wire shape, not to
  translate it into a parallel framework-native shape that the
  operator would have to learn separately.
- **Aesthetic discipline** (co-equal with capability per
  `docs/operator-philosophy.md` §Aesthetic discipline). The
  framework's defaults push toward or away from operator-philosophy-
  aligned UIs. A framework whose ergonomic path produces framework
  chrome (welcome banners, hot-reload overlays, dev-mode badges) is
  working against the discipline; one whose ergonomic path is
  plain-HTML-and-stylesheet is working with it.

## Decision

newtcon's browser frontend is built as **vanilla HTML + TypeScript-as-
typed-ES-modules**, with no SPA framework, no client-side framework
runtime, and no bundler. The TypeScript compiler (`tsc`) is the
only build dependency; the build is `tsc` plus copying static
`*.html` and `*.css` files into `web/dist/`. Output is plain ES
modules that the browser loads via `<script type="module">`.
`newtcon-server` serves `web/dist/` as static assets per
[`docs/architecture.md`](../architecture.md) §File ownership map.

### Same-origin serving model

The build produces **static files** under `web/dist/`. `newtcon-server`
serves them at `/` (and at `/<asset-path>` for any file under
`web/dist/`) via `http.FileServer` per newtcon#104's scope. The
browser then issues same-origin requests to `/api/*` for
`newtcon-server` and cross-origin requests to `newtrun-server`. No
Node-side serve step is part of dev or prod; the Go binary alone is
sufficient to serve the frontend.

This satisfies the build/scaffold cost criterion the strongest: no
Node process at runtime, no `npm run dev` parallel to the Go server
during development. The operator running `bin/newtcon-server`
gets the frontend; rebuilding the frontend is `(cd web && npm run build)`
and the running Go server picks up the new files without a restart.

### Build and test commands

Per the issue's acceptance criterion 6, the commands the chosen
framework requires are specified verbatim here so that
`team-launch.md` §Completion criterion 5 has a concrete referent:

- **Install:** `cd web && npm install` (installs only `typescript`
  and a test runner per the `package.json` scaffolded by
  newtcon#104).
- **Build:** `cd web && npm run build` — runs `tsc --project tsconfig.json`
  to produce ES modules in `web/dist/`, then copies `web/src/index.html`
  and any `web/src/**/*.css` into `web/dist/`.
- **Test:** `cd web && npm run test` — runs the chosen test runner
  (Node's built-in `node:test` with a small DOM stub for unit-level
  rendering tests, or `vitest` if a richer assertion vocabulary is
  warranted; newtcon#104 selects between them at scaffold time and
  records the choice in `web/README.md`).
- **Type-check (no emit):** `cd web && npm run typecheck` — runs
  `tsc --noEmit` for CI gating without producing build artifacts.

`package.json` pins all dependency versions exactly (no `^` / `~`
ranges) per newtcon#104's requirement, derived from
[`CLAUDE.md`](../../CLAUDE.md) §Greenfield and operator-philosophy
invariant #9 (explicit limits — the dep graph must be reproducible).

### Why this decision, against the four selection criteria

1. **Bundle size.** Zero framework runtime in the browser. The only
   JavaScript the browser downloads is the application's own ES
   modules, compiled from the application's own TypeScript. A
   first-page payload for the services-listing milestone is on the
   order of a few kilobytes of HTML + CSS + JS — measurable against
   the page's own substrate, not against a framework's baseline.

2. **TypeScript first-class.** `tsc` is the build. The typed clients
   under `web/src/api/newtcon/` and `web/src/api/newtrun/` are
   straightforward TypeScript modules whose exported types mirror
   `newtcon-server`'s `internal/types/` and `newtrun-server`'s
   public DTOs. Per `DESIGN_PRINCIPLES_NEWTRON.md` §46 (wire shape
   mirrors substrate), the typed-client shape *is* the wire shape;
   no transformation layer is needed.

3. **Component model.** Browser-native primitives — Custom Elements
   (Web Components) when state is genuinely cross-cutting, plain
   template functions returning DOM nodes when it is not — cover
   the read-only services-listing page (template functions
   sufficient), the Operator Inbox cards (Custom Element per card
   kind, if useful), the Composer's target-selection grid (template
   functions over a state object the page owns), and the Workbench's
   batch editor (likewise). Browser-native primitives are the
   component model; no framework component model is imposed. The
   "exotic patterns" the criterion warns against (framework-specific
   reactivity, JSX, signal graphs, hooks) are absent by construction.

4. **Two-backend composition ergonomics.** The frontend holds two
   typed client modules — `web/src/api/newtcon/` and
   `web/src/api/newtrun/` per `docs/architecture.md` §File ownership
   map. Composition happens at the workflow layer
   (`web/src/workflows/`) in plain TypeScript. Server-Sent Events
   are consumed via the browser-native `EventSource` API; no
   framework SSE adapter is required. The composition is plain code
   the operator can read in `web/src/workflows/composer.ts` and
   trace end-to-end from page load to commit.

### Aesthetic litmus test for this framework choice

Per `docs/operator-philosophy.md` §The aesthetic litmus test:
*does the operator want to open this tool?* The framework-defaults
question, applied to vanilla HTML + TypeScript: the "default
output" of this approach is *the operator's own HTML and CSS,
rendered by the browser, with no framework branding, no welcome
banner, no dev-mode overlay, no scaffolded landing page*. A
first-time visitor to the page sees whatever the author put in
`web/src/index.html` — nothing more.

That is the aesthetic-discipline payoff. There is no framework-
chrome layer the design system has to fight. F3 (newtcon#106)
authors the design-system seed against a blank slate; the typography,
color, spacing, and motion choices land on the operator's own DOM,
not on a framework's component-tree DOM. The discipline is enforced
by absence.

### Capability litmus test for this framework choice

Per `docs/operator-philosophy.md` §The litmus test: an operator who
uses newtcon for a year must be **more capable** than when they
started, ideally able to file PRs at the method level.

The chosen approach makes the frontend's source legible to anyone
who knows HTML, CSS, and JavaScript — which every working network
operator already knows in some measure. There is no framework's
mental model to learn before reading
`web/src/workflows/composer.ts` and understanding what the
Composer does. The operator who wants to propose a fix to the
Inbox's drift-card rendering reads
`web/src/surfaces/inbox/drift_card.ts`, sees plain DOM construction
and plain `fetch` calls against `/api/history/...`, and can
propose the fix at the method level. A framework would add a layer
the operator must first learn (component lifecycle, reactivity,
state-management idioms) before they can contribute.

This is the strongest expression of invariant #1 (no black boxes):
the rendered page IS the source the operator reads. View-source on
any page shows DOM the operator's `web/src/` source produced
directly, modulo `tsc`'s straightforward TS→JS translation (no JSX,
no SFC, no bundler-rewritten module paths).

### Substrate-is-teaching-surface test for this framework choice

Per invariant #3: the framework must not invent client-side
substrate that does not exist on the wire.

The chosen approach has no framework-native client-side substrate
to invent. The data the page renders is `ServiceListResponse` from
`GET /api/services`, decoded via `JSON.parse` into a TypeScript type
that mirrors `internal/types/services.go`'s shape per
`DESIGN_PRINCIPLES_NEWTRON.md` §46. There is no framework store, no
reactive proxy, no derived state that lives outside the wire shape.
When Composer arrives, the same property holds: the typed client
returns `EventStepProgress` events whose shape is newtrun-server's
wire shape, rendered as DOM by plain code. The operator's mental
model of "what is the substrate" matches the frontend's
representation of it 1:1.

## Considered alternatives

### Why not vanilla HTML + minimal JS (no TypeScript, no build step)

The operator's stated baseline. This alternative is the truly
zero-scaffold path: HTML files with `<script>` tags pointing at
hand-written `.js` files, no `npm`, no `tsc`, no `package.json`.
The Go binary serves the files as-is.

The defense for adding TypeScript-via-tsc on top of this baseline
turns on the **TypeScript first-class** selection criterion
(`docs/architecture.md` §Frontend framework selection criterion 2).
Both `newtcon-server`'s and `newtrun-server`'s HTTP APIs are typed;
the typed shapes are the wire shapes per
`DESIGN_PRINCIPLES_NEWTRON.md` §46. Consuming those typed shapes
in untyped JavaScript means either (a) writing the same shape
twice — once as the Go type, once as a JSDoc `@typedef` — with no
mechanical guarantee the two stay in sync, or (b) consuming the
shapes as untyped `any` and accepting runtime parsing errors as the
only signal that a field changed. Both options work against
invariants #1 (no black boxes) and #9 (confidence and limits are
explicit): a wire-shape change that breaks the page should surface
at build time as a type error, not at runtime as a `TypeError:
Cannot read properties of undefined`.

TypeScript-via-tsc is the smallest possible deviation from
truly-vanilla that satisfies the typed-shape criterion. The added
cost is **one Node-for-build dependency** (`typescript`), **one
config file** (`tsconfig.json`), and **one build command**
(`tsc`). There is no bundler, no framework runtime, no
client-side dependency surface. The Node process is required only
at build time; the served output is plain ES modules. The added
cost is bounded and recovered the first time a `newtcon-server`
DTO changes and the type-checker flags every frontend usage
mechanically.

The decision sits one notch heavier than the operator's stated
baseline, defended on the specific criterion the architecture
document binds. The discipline that produced the operator's
intervention — pick the lightest path that meets the criteria —
is honored: this is the lightest path that meets criterion 2.

### Why not HTMX + minimal JS (server-rendered HTML fragments)

HTMX is the strongest alternative to the decision. It is small (~14KB
gzipped), browser-native in its interaction model (`hx-get`,
`hx-post`, `hx-swap` as HTML attributes), and produces server-rendered
HTML the operator can read end-to-end. It would honor invariant #1
(no black boxes) and invariant #3 (substrate is teaching surface)
particularly cleanly: every page interaction is a request the
operator can see in DevTools and replay with `curl`.

HTMX is rejected for one structural reason and one trajectory reason.

**Structural reason: it would push `newtcon-server` toward serving
HTML fragments alongside its current JSON API.** `newtcon-server` is
a JSON-over-HTTP server per [`CLAUDE.md`](../../CLAUDE.md) §newtron
API Consumption Rule (which binds the upstream-consumption pattern
and, by parallel discipline, the outward-serving pattern). Adding
HTML-fragment endpoints would mean either (a) duplicating each
JSON endpoint with an HTML-rendering counterpart, doubling the
contract surface for no substrate gain, or (b) routing the same
endpoint to two response shapes based on `Accept` header, which is
content-negotiation complexity the contract does not currently
admit. The post-rebalance architecture per
[ADR-0001](0001-scope-justification-vs-newtrun.md) keeps
`newtcon-server` deliberately small; adding a templating story is
a scope expansion at exactly the wrong moment.

**Trajectory reason: the future workflows are heavier than HTMX's
ergonomic path.** Composer needs to compose a UI state (selected
targets across multiple nodes, preview result, commit confirmation)
that exists in the browser between requests, not on the server.
Inbox needs to consume SSE from `newtrun-server` and render
real-time event streams — HTMX's `hx-sse` extension exists but
the wire is `newtrun-server`'s SSE, not a `newtcon-server`-rendered
fragment stream. The structural fit is wrong: HTMX optimizes for
server-rendered surfaces against a single backend, and newtcon's
frontend composes two backends with the heavier of the two
(`newtrun-server`) emitting binary-substrate events the browser
must render directly.

HTMX would land the first-page milestone faster than the chosen
approach (no `tsc` step, smaller scaffold). It would land the
Composer/Inbox/Workbench milestones slower, against architectural
grain. The Architect chooses the path that does not require
re-litigation when the harder surfaces arrive.

### Why not Svelte / SvelteKit

Svelte is the lightest of the mainstream component-framework options
(smallest runtime, compile-to-vanilla-JS output). Its
component-as-file (`.svelte`) ergonomic is clean; its reactivity is
the smallest mental-model among reactive frameworks; its bundle
output approaches "no framework" at runtime.

It is rejected for three reasons.

**It introduces a compile-to-non-source step.** `.svelte` files
compile into JavaScript that does not resemble the `.svelte` source.
The operator who reads `web/src/surfaces/inbox/drift_card.svelte`
and then `View Source`s the rendered page sees a different
artifact — the compiler's output, not the author's source. That is
a black box at the presentation layer per invariant #1, even when
the runtime is small. The defense "but the dev tools map back to
source" applies only to operators who have the dev tools installed
and the source map loaded; the philosophy's "view-source must make
sense" demand is stricter than that.

**SvelteKit (the full framework) brings server-side rendering, file-
based routing, and a build system that wants to manage the asset
pipeline.** That is a much larger scaffold than the chosen approach,
and the trajectory of the post-rebalance architecture per
[ADR-0001](0001-scope-justification-vs-newtrun.md) does not warrant
it: `newtcon-server` serves static assets; routing is one page until
Composer arrives, and Composer is one more page. File-based routing
is over-fit for a console with on the order of five top-level
surfaces.

**Plain Svelte (without SvelteKit) is closer to the decision in
spirit but adds the component-syntax mental model on top.** The
operator filing a PR at the method level must learn `.svelte`'s
template grammar, its reactivity (`$:`, `$state`), and its event-
dispatching idiom before they can contribute. The chosen approach
adds none of these: HTML, CSS, TypeScript are the primitives.

### Why not React + Vite

React is the conventional choice and has the largest ecosystem. Vite
is a fast, well-understood build tool. The combination is
well-trodden and would deliver every newtcon surface that is
plausible to build.

It is rejected for the same structural reasons that Svelte is,
applied more strongly: React's runtime is larger; JSX is a deeper
compile-from-non-HTML transformation than Svelte's; the reconciler,
hooks, and effect-cleanup model are a substantial mental-model
overhead for an operator who wants to contribute a fix to the
Composer's preview rendering. The bundle size criterion
(`docs/architecture.md` §Frontend framework selection criterion 1)
is the headline failure: React + ReactDOM is ~45KB gzipped before
any application code, against a page whose substrate is six fields
per row. The framework outweighs the substrate.

React's component model would also push the frontend toward
client-side state management (Redux, Zustand, or the operator-team-
flavor-of-the-month) for any surface that holds state between
fetches. Per invariant #3 (substrate is teaching surface), the
frontend must not invent client-side substrate that does not exist
on the wire; client-side state stores are exactly that invention.
The chosen approach avoids the temptation by avoiding the framework
that creates it.

### Why not Solid

Solid is the closest reactive framework to the decision — small
runtime, fine-grained reactivity, JSX-but-compiled-to-DOM-directly.
It is the best-engineered framework in the modern reactive class.

It is rejected on the same JSX-as-compile-from-non-HTML grounds as
Svelte, and on the same client-side-substrate grounds as React. The
fine-grained reactivity is a beautiful primitive for applications
whose substrate is a deep reactive graph; newtcon's substrate is
typed records from two HTTP backends rendered as DOM. The framework's
strongest affordance does not align with the substrate's shape.

## Consequences

### What becomes easier

1. **The build is one command and one dependency.** `npm install` then
   `npm run build`; `web/dist/` is then a directory of static files
   `newtcon-server` serves. CI runs the same two commands. There is
   no bundler config, no plugin ecosystem to maintain, no
   framework-major-version migration risk.

2. **View-source on any page shows the operator their own DOM.** The
   structural property invariant #1 demands is satisfied by absence
   of framework, not by careful framework configuration. F3
   (newtcon#106) authors the design-system seed against a blank
   slate; the typography, color, and spacing choices land on plain
   HTML.

3. **The typed-client modules are plain TypeScript that mirrors the
   server-side Go types.** Per `DESIGN_PRINCIPLES_NEWTRON.md` §46,
   the wire shape mirrors the substrate; the TypeScript types under
   `web/src/api/newtcon/` and `web/src/api/newtrun/` are direct
   mirrors of `internal/types/services.go` etc. Type drift between
   server and client surfaces at build time, not runtime.

4. **The contributor learning curve is HTML, CSS, TypeScript.** An
   operator who wants to file a PR against the Composer's preview
   rendering reads `web/src/workflows/composer.ts`, sees plain
   `fetch` calls and plain DOM construction, and can propose the
   fix at the method level. No framework idiom must be learned
   first. This is the capability litmus test honored at the
   contributor layer.

5. **Composer/Inbox/Workbench will compose `newtrun-server`'s SSE
   without an adapter.** The browser-native `EventSource` API
   consumes `GET /api/runs/{suite}/events` directly; rendering each
   `EventStepProgress` is plain DOM construction over the
   verbatim-substrate event body. No framework SSE adapter
   intermediates between the wire and the DOM.

### What becomes harder

1. **State management for stateful surfaces is hand-rolled.**
   Composer holds selection state across multi-node target picking;
   Workbench holds batch-edit state. Each surface owns its state
   object directly, with explicit re-render calls when state
   changes. A framework would automate the re-render trigger; the
   chosen approach makes it explicit. For surfaces whose state graph
   is small (which the post-rebalance frontend's are, per ADR-0001),
   the explicitness is a feature; for surfaces whose state graph
   grows large, the burden grows accordingly. If a future surface
   has a state graph large enough to justify a reactive primitive,
   the right response is a small reactive utility added to
   `web/src/lib/`, not a framework adoption. Such a utility would
   itself be ADR-worthy.

2. **There is no router for free.** When the second page lands
   (likely the Provenance drill-down per Composer), the Architect
   either adds a small client-side router (~50 lines of plain JS) or
   the surfaces remain server-routed by `newtcon-server`. Both are
   tractable; neither is the framework-router automation. The
   decision is deferred to the slice that actually needs it.

3. **The design-system seed authors plain CSS, not framework-
   themed component primitives.** F3 (newtcon#106) writes
   `web/src/design-system/{typography,color,spacing,motion}.css` per
   the slice's scope. A framework with theming primitives (e.g.,
   styled-components, Tailwind) would offer a different ergonomic.
   The chosen approach treats CSS as the design-system substrate
   directly; the operator who inspects the cascade in DevTools sees
   the rules the author wrote. This aligns with invariant #1.

4. **Test-runner choice is one extra decision per scaffold.** Vanilla
   has no opinionated test runner. newtcon#104 selects between
   Node's built-in `node:test` (with a small DOM stub) and `vitest`
   at scaffold time and records the choice in `web/README.md`. The
   selection is bounded; neither outcome blocks the slice.

5. **TypeScript-without-a-bundler has small ergonomic edges.**
   Each module's relative-import path must include the `.js`
   extension that the browser will load (e.g.,
   `import { fetchServices } from "./api/newtcon/services.js"` even
   though the source file is `.ts`). This is well-understood
   TypeScript-with-`moduleResolution: "node16"` behavior; newtcon#104
   documents it in `web/README.md` as a one-line note. The cost is
   trivial and the payoff is no-bundler.

### Risks the decision creates

1. **A future surface might genuinely benefit from a framework's
   ergonomics, and the team would have to author a superseding
   ADR.** The decision is reversible per the ADR-supersession
   protocol in [`docs/adr/README.md`](README.md). The reversal cost
   is the cost of porting the surfaces that exist at that moment to
   the new framework. For the read-only services-listing page and
   the design-system seed, the porting cost is low; for a fully-built
   Composer, the porting cost is real. The right gate is "do not
   choose a framework until a surface actually needs one." That
   gate is honored by this ADR; the risk is that a future ADR will
   misjudge "actually needs one" and adopt a framework
   prematurely. The mitigation is the same survey discipline that
   produced this ADR.

2. **The decision will be questioned by anyone whose default frame
   is "of course you use React/Svelte/etc."** This is a social risk,
   not a substrate risk. The defense is the document you are
   reading. Future contributors who propose a framework adoption
   must clear the same alternatives bar this ADR cleared in the
   opposite direction.

3. **`tsc` is a single point of build failure.** A `typescript`
   release that changes ES-module emit behavior in a way the
   frontend depends on could break the build. The mitigation is
   the exact-version pin in `web/package.json` (no `^` / `~`
   ranges) per newtcon#104's requirement, plus the standard
   Renovate-style upgrade discipline when a `typescript` minor
   release is reviewed.

4. **The lack of a framework's accessibility primitives means
   accessibility is hand-rolled.** Operator-philosophy invariant
   #1 (no black boxes) implies accessibility — a tool the operator
   cannot inspect is a tool whose substrate is hidden, and the
   same logic applies to operators using assistive technology.
   F3 (newtcon#106) and any future design-system ADR carry the
   accessibility burden explicitly: semantic HTML elements,
   ARIA where the semantic element is insufficient, keyboard
   navigation as a first-class concern. The chosen approach
   does not provide a free accessibility primitive layer; it does
   not provide an inaccessibility footgun either.

## Operator-philosophy invariants honored

The decision honors four of the nine invariants in
[`docs/operator-philosophy.md`](../operator-philosophy.md), plus the
aesthetic-discipline statement that the document declares co-equal
with capability:

- **Invariant #1 — No black boxes.** The rendered page is the
  source the operator wrote. View-source on any page shows DOM
  the operator's `web/src/` source produced directly via plain
  `tsc` translation; no framework-rewritten DOM, no bundler-
  rewritten module paths, no framework runtime intermediating
  between source and rendered output. The frontend's behavior is
  inspectable end-to-end with the browser's built-in dev tools.

- **Invariant #3 — The substrate is the teaching surface.** The
  frontend invents no client-side substrate. The data rendered is
  the wire shape from `newtcon-server`'s and `newtrun-server`'s
  HTTP APIs, decoded via `JSON.parse` (for fetches) and
  `EventSource` event bodies (for SSE), typed via TypeScript
  modules that mirror the upstream Go DTOs. The operator's mental
  model of "what is the substrate" matches the frontend's
  representation 1:1. There is no framework store, no derived
  state graph, no reactive proxy that lives outside the wire shape.

- **Invariant #5 — Why-mode is always available.** The framework
  choice does not directly deliver why-mode (that is a content-
  level concern per surface), but it does not work against it:
  every UI element is plain DOM the author can decorate with a
  why-mode anchor link directly in the template function or
  Custom Element render method. A framework with implicit DOM
  generation would impose a layer between the author and the
  rendered element; this approach does not.

- **Invariant #9 — Confidence and limits are explicit.** The
  `package.json` pins dependency versions exactly per newtcon#104.
  The build is reproducible from a clean checkout via two
  commands. There is no implicit dependency graph the framework
  manages on the author's behalf. The frontend's failure modes
  are limited to: (a) `tsc` build failures (surface at build
  time, before deployment), (b) runtime fetch failures (rendered
  with substrate-honest error states per newtcon#105's scope),
  and (c) DOM-construction bugs in the author's own code (which
  are the only bugs the operator should have to reason about).
  There is no framework's failure mode the operator has to
  account for separately.

- **Aesthetic discipline.** Per
  [`docs/operator-philosophy.md`](../operator-philosophy.md)
  §The aesthetic litmus test (*"does the operator want to open
  this tool?"*): the framework's default output is *the operator's
  own HTML and CSS*, with no framework branding, no welcome
  banner, no dev-mode overlay. F3 (newtcon#106) authors the
  design-system seed against a blank slate; the discipline is
  enforced by absence of framework chrome to fight.

## Newtron principles honored

The decision derives from and operationalizes the following sections
of `../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`:

- **§8 — Scope Boundaries.** The framework choice respects the
  three-tool partition that
  [ADR-0001](0001-scope-justification-vs-newtrun.md) made binding:
  newtron per-device, newtrun orchestration, newtcon observation
  plus the browser frontend. A framework that wanted to manage
  routing, state, and substrate-rendering on the frontend would be
  a fourth tool emerging on the presentation layer. The chosen
  approach has no such gravitational pull; the frontend is plain
  TypeScript composing two HTTP backends, and the substrate
  partition stays where ADR-0001 placed it.

- **§14 — Verify Your Writes; Observe Everything Else.** The
  frontend is structurally on the observation side of the line for
  state-changing workflows (per
  [`docs/architecture.md`](../architecture.md) §Surfaces and
  substrate paths: `newtrun-server` mediates the writes; the
  frontend renders the events). The chosen approach reflects this
  asymmetry: rendering is the frontend's primary job, and the
  framework choice optimizes for rendering plain typed substrate,
  not for managing client-owned state-change machinery.

- **§33 — Public API Boundary — Types Express Intent, Not
  Implementation.** TypeScript modules under `web/src/api/newtcon/`
  and `web/src/api/newtrun/` express the wire-level intent of each
  endpoint in domain vocabulary (e.g., `ServiceListResponse`,
  `EventStepProgress`). The implementation of those types — how
  the frontend renders them, how it composes across two backends —
  is internal to `web/src/workflows/` and `web/src/surfaces/`. The
  type identity vs implementation split that §33 makes binding on
  newtron's Go boundary applies symmetrically to the frontend's
  TypeScript boundary.

- **§46 — HTTP API Boundary — Wire Shape Mirrors Canonical Types.**
  This is the load-bearing principle for the framework choice.
  §46 binds newtron's wire output to mirror the canonical types it
  produces internally; per parallel discipline, the frontend's
  client-side type model must mirror that wire shape, not invent a
  parallel framework-native shape. The chosen approach has no
  framework-native shape to invent — TypeScript types directly
  mirror the wire-level JSON, and the rendering layer consumes
  those types directly. The principle is honored by structural
  absence of any layer that would violate it.

## Implementation notes

The first three slices consuming this ADR are:

- **newtcon#104** scaffolds `web/` with `package.json` (pinning
  `typescript` exactly), `tsconfig.json` (`target: "ES2022"`,
  `module: "Node16"`, `moduleResolution: "node16"`, `outDir: "dist"`),
  the build script that runs `tsc` and copies static assets, and
  the test-runner choice. `newtcon-server` gains a `--web-dir`
  flag and static-file serving at `/`. (TypeScript 5.0+ enforces
  `module: "Node16"` whenever `moduleResolution: "node16"` — error
  TS5110 — so this is the combination F1 selected per its
  `tsconfig.json`; `NodeNext`-rooted variants — `module: "NodeNext"`
  paired with either `moduleResolution: "node16"` or `"nodenext"` —
  are also legal but adopt forward-looking semantics F1 did not
  need.)

- **newtcon#105** implements the read-only services-listing page
  in plain HTML + TypeScript + CSS, consuming `GET /api/services`
  via a typed client at `web/src/api/newtcon/services.ts` that
  mirrors `internal/types/services.go`'s `ServiceListResponse`.

- **newtcon#106** authors the design-system seed under
  `web/src/design-system/` as plain CSS files (`typography.css`,
  `color.css`, `spacing.css`, `motion.css`) plus a `README.md`
  documenting the choices made and the choices deferred to future
  design-system ADRs.

The decision is reversible per the ADR-supersession protocol in
[`docs/adr/README.md`](README.md). The Architect of any future surface
whose substrate genuinely warrants a framework adoption (per the
same alternatives-survey discipline this ADR followed) may author a
superseding ADR.
