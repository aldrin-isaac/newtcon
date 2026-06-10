# newtcon roadmap

**Status:** living document. Future-considered features that the
operator has tracked but not yet committed to newtcon's current scope.

## Purpose & scope discipline

This document is the **considered list** of features not in newtcon's
current scope (see [`docs/DIRECTIVE.md`](DIRECTIVE.md) §The operator workflow loop + §Slice plan) but
worth tracking. It is **distinct from the working backlog** at
<https://github.com/aldrin-isaac/newtcon/issues>:

| Working backlog (GitHub Issues) | Roadmap (this document) |
|---|---|
| Items in current scope | Items deliberately deferred to a future cycle |
| Picked up by the autonomous team | NOT picked up by the team |
| One issue per slice or Contract PR | One entry per feature concept |
| Drives merges to main | Drives future scope-promotion decisions |

Entries here are **not** a commitment to ship. They are the operator's
tracked considerations: features that look principled and useful but
that would dilute current focus if added now. Promotion to current
scope is operator-driven; until then they live here.

This document is also **distinct from out-of-scope rejections**.
Out-of-scope items are rejected on principle (multi-tenant features,
mobile-first UI, anything that violates `docs/operator-philosophy.md`);
they will not be added. Future-considered items are deliberate deferrals;
they may be promoted to current scope when conditions are met.

## Promotion / demotion protocol

Each entry carries a `Status` field with one of three values:

- **`future`** — under consideration, not actively designed. Held for
  a future decision.
- **`under-evaluation`** — operator is actively weighing promotion.
  Entry may grow design detail; questions in "Open questions" are
  being closed.
- **`scoped`** — promoted to current scope. The entry remains here
  for traceability but is now driven by GitHub issues. The directive
  (`docs/DIRECTIVE.md` §Slice plan) is updated to reflect the new
  scope. Issues are filed for the implementer.

**Promotion** (`future → under-evaluation → scoped`) is operator-driven.
The promotion PR:

1. Updates the entry's `Status` field.
2. If promoting to `scoped`, adds the slice to `docs/DIRECTIVE.md`
   §Slice plan and files corresponding issues.
3. Records the promotion rationale in the entry (one paragraph).

**Demotion** (any status → removed) is also operator-driven. Entries
can be removed if the design choice is no longer aligned with the
philosophy or has been judged out-of-scope on principle.

## Why a separate document, not GitHub issues

Issues are work-items; roadmap entries are tracked considerations.
Mixing them clutters the backlog and pushes "do it now" framing onto
features deliberately deferred. The autonomous team works the issue
queue; if roadmap entries were issues, the team would treat them as
backlog and start designing — exactly the focus-dilution this
document exists to prevent.

When an entry is promoted to `scoped`, that is the moment issues are
filed.

---

## Entries

### 1. Spec authoring

**Status:** future

**Why it matters:** Operators who can extend the service catalog
become **co-developers of the automation** — the strongest form of
the capability litmus test in
[`operator-philosophy.md`](operator-philosophy.md). Today, defining a
new service type, modifying a service spec, or adjusting a profile or
zone requires editing YAML/JSON on the host filesystem (or using the
newtron CLI's `create-*` / `delete-*` verbs). This friction caps
operators at "deploy what's already in the catalog" rather than
"extend what the catalog can do."

**What it is:** newtcon surface(s) for operators to create, edit, and
delete network-scoped specs that newtron owns
(`../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md` §7):

- Service specs (`spec.ServiceSpec`).
- Device profiles (`spec.DeviceProfile`).
- Zones (`spec.ZoneSpec`).
- **Topology** — devices (`spec.TopologyDevice`) and links
  (`spec.TopologyLink`) in `topology.json`. Adding, removing, or
  rewiring devices is operator work, not the Apstra-paradigm
  canvas (`docs/architecture.md` §Non-Goals).

For services, profiles, and zones, edits land through newtron-server's
**existing** typed verbs (`POST /network/{netID}/create-service`,
`/create-profile`, `/create-zone`, and their `delete-*` / `add-*` /
`remove-*` counterparts). Persistence happens via
`Network.SaveService` / `SaveProfile` / `SaveZone`, which call
`spec.Loader.SaveNetwork`.

For **topology**, the underlying persistence
(`spec.Loader.SaveTopology` — temp-file + atomic rename) **already
exists** in newtron, but newtron-server exposes no HTTP endpoints to
invoke it. The gaps:

- `GET /network/{netID}/topology` — full typed topology read (only
  `/topology/node` exists today, and it returns device names only).
- Topology node CRUD: `POST /create-node`, `DELETE /node/{device}`,
  `PUT /node/{device}` for property updates.
- Topology link CRUD: `POST /create-link`, `DELETE /link/{from}/{to}`.

These are filed as Gap-Handling Protocol issues against newtron
(operator-driven, since the autonomous team does not touch newtron).
Promotion of the topology portion of this entry to `scoped`
depends on those newtron gaps landing.

**Infrastructure consequence for topology edits:**

Adding or removing a device has consequences outside newtron's spec
layer. In **lab mode**, newtlab re-deploys (starts/stops VMs,
configures bridges). In **production**, the operator performs the
physical rack-and-cable step (or removes a switch from service).
newtcon's spec-authoring surface does not invoke newtlab and does
not perform physical operations — it mediates the spec edit and
shows the operator what downstream steps are required (in lab mode:
"run `newtlab deploy` to reflect this change"; in production: "this
edit assumes the physical device is present").

**What it is NOT:**

- Not deep policy editing (ROUTE_MAP, PREFIX_SET, COMMUNITY_SET
  primitives) — those belong to a network-architect tool, if any.
  Operator spec authoring is bounded to the spec types operators
  commonly extend.
- Not a free-form YAML text editor — substrate-faithful but
  schema-aware, with validation against newtron's YANG-derived
  schemas (`§13`).
- Not a replacement for the newtron CLI — the CLI verbs remain
  authoritative; newtcon's spec-authoring surface is one path among
  several to invoke them.

**Principle alignment:**

- **Operator-philosophy invariant #3 (substrate is teaching):** the
  spec source (YAML / JSON) is shown in the surface; operators
  internalize the spec format by seeing it constantly.
- **Invariant #4 (show before do):** preview the spec edit's diff
  against the current spec; show the rendered effect on the catalog
  (which Composer / Inbox cards become possible with the new spec)
  before commit.
- **Invariant #5 (why-mode):** every spec field links to its
  documentation in newtron's spec types.
- **Invariant #2 (manual-mode parity):** the surface shows the file
  path that would be modified and the exact `bin/newtron <verb>`
  CLI invocation that achieves the same edit, for the operator to
  run in their own terminal if newtcon is unavailable.
- **Newtron `§13` (YANG-derived schema):** validation against
  newtron's schemas, fail-closed on unknown fields.
- **Newtron `§16` (verb vocabulary):** spec edits map to newtron's
  existing verbs (`create-service`, `add-acl-rule`, ...) — no new
  vocabulary invented.

**Triggers for promotion to `scoped`:**

- v1 primary surfaces (Composer, Inbox, Workbench, Provenance,
  Rehearsal, Manual-mode parity) ship and stabilize.
- Operator validates need on three or more tasks ("I've wanted to
  add a new service type three times this month and the YAML edit is
  the friction").
- Team velocity allows a new surface without delaying current scope.

**Open questions:**

- What subset of spec types belongs in newtcon vs. a separate
  network-architect tool?
- How to surface validation errors substratically (show the YANG
  rule that rejected the field, not a "Validation failed" toast)?
- Editing in a stash-and-commit flow (analogous to the Workbench),
  or land each edit immediately?
- Read-mostly spec visibility woven into v1 surfaces should be a
  precursor — operators see specs constantly before they ever edit
  one. How rich does that v1 visibility need to be?

---

### 2. Graphical topology visualization / change

**Status:** future

**Why it matters:** The physical network shape — which devices
exist, which links connect them, which tier each device belongs to,
which addresses they carry — is substrate the operator currently has
to assemble in their head from YAML files and CLI output. A
graphical view *can* be substrate-faithful: it reads the topology
spec + projection state and renders the actual structure, not a
designer's imagined blueprint. Done right, it amplifies the
operator's spatial understanding of the network — they recognize
unusual link patterns, identify which tier a problem device sits in,
and navigate to operating surfaces faster than they would by reading
device names.

**What it is:**

A topology graph view sourced from newtron's topology spec and
projection state. Nodes are devices; edges are links between them
(physical interconnects per the topology spec). The view is the
operator's spatial entry point to the existing operating surfaces:
click a node to drill into its Composer / Inbox / Provenance views;
click an edge to see the interface bindings and substrate at both
ends.

**Default layout: concentric rings, tier-centric.** The default mode
renders the topology as concentric rings ordered by network tier:

- **Innermost ring:** core / backbone tier (devices with mostly
  inter-device links and few external-facing ports — spine layer in
  CLOS, core routers in traditional designs).
- **Intermediate rings:** aggregation / distribution / leaf tiers if
  present, ordered from core outward.
- **Outermost ring:** edge tier (devices facing servers, customers,
  or external networks).

This default is **deterministic from spec** — the same topology spec
produces the same ring placement every time. Tier classification is
derived from the device's profile (the canonical source; profile-
defined tier is preferred when present), with topology-graph
analysis as fallback (devices with mostly external-facing links land
on the outer rings; devices with mostly inter-device links land
inward).

**Alternative layout modes** (operator switches via UI; same
substrate, different rendering):

- Force-directed (for non-tiered fabrics).
- Hierarchical (top-down by tier, useful for documentation).
- Manual placement (operator-pinned nodes for custom views, with
  spec-derived defaults underneath).

Each mode is **deterministic** for the same input (manual mode
persists its placements as part of the operator's local view
preferences, not as topology spec changes — viz preferences are
newtcon-owned, not newtron-owned).

**Editing in this surface** routes through the Spec authoring
surface (entry 1, widened to include topology). The topology view is
a navigation and visualization layer; structural changes (adding a
device, adding a link) happen through spec authoring with the
topology view as one feedback surface among several. The visual edit
gesture (e.g., clicking "add a device" in the graph) opens the spec-
authoring affordance for `topology.json`, with substrate visibility,
schema validation, and the manual-equivalent CLI shown — never a
free-form canvas action that bypasses the spec layer.

**What it is NOT:**

- **Not a drag-and-drop blueprint editor.** This is the Apstra
  paradigm explicitly rejected in `docs/architecture.md`
  §Non-Goals. The topology view visualizes what the spec says
  exists; it does not let operators design a network they then
  build. Structural changes go through spec authoring with full
  substrate visibility, not through dragging icons onto a canvas.
- **Not the primary landing surface.** Operators land on the Inbox
  (work that needs attention), not on the topology (admiring the
  network). The topology view is a navigation aid woven into
  existing surfaces, not the first thing the operator sees.
- **Not invented topology.** Every node and edge in the view
  corresponds to a real entry in the topology spec; the view never
  shows aspirational or projected structure that doesn't exist in
  the spec.
- **Not a real-time monitoring dashboard.** Drift / health /
  convergence signals are surfaced by the Inbox; the topology view
  may surface them as secondary annotations (e.g., color a node by
  drift status), but it is not a status-light surface.

**Principle alignment:**

- **Substrate faithfulness (`newtron §46` extended to the UI):** the
  graph is the topology spec rendered, not an alternate
  representation invented for display.
- **Operator-philosophy invariant #1 (no black boxes):** clicking
  any node or edge surfaces the underlying spec entries (device
  profile, interface bindings, addresses), not a summary.
- **Invariant #3 (substrate is teaching):** the graph teaches
  network shape; the tier-centric default reinforces the operator's
  mental model of where each device sits architecturally.
- **Invariant #5 (why-mode):** every visual element navigates to
  its substrate — the tier classification surfaces "this is on the
  inner ring because the profile says `tier: core`."
- **Aesthetic discipline:** concentric rings are calm and readable at
  first sight; deeper detail (per-edge bindings, per-node substrate)
  is one click away. The default layout is deterministic, not
  free-form — operators get the same view every time, which
  reinforces spatial memory.

**Triggers for promotion to `scoped`:**

- v1 primary surfaces ship and stabilize.
- Operator validates that graphical visualization earns its
  complexity. Text-based topology display might be enough for
  operator daily work; the user's prior intelligent-operator system
  used text affordances primarily and produced excellent outcomes.
  Graphical viz is principled but not obviously necessary.
- Spec authoring (entry 1) is at least `under-evaluation`, since
  topology changes route through it.

**Open questions:**

- How to derive tier classification reliably when profile lacks an
  explicit tier annotation? Topology-graph analysis (degree, link
  type) as fallback — what's the algorithm?
- How does the view scale at 100+ device fabric scale?
  Concentric-ring layout works well at small-to-medium scale; large
  fabrics may need hierarchical or zoomed-region views.
- Multi-zone visualization — one ring per zone, or zones as colored
  regions across a single set of rings?
- Edge styling — how to render link capacity / state / type without
  cluttering the view?
- Persistence of manual-placement preferences — local to the
  operator's browser session, or stored in newtcon's observation
  history layer (entry: future) as a user preference?
