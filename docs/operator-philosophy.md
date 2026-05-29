# Operator Philosophy: Intelligent Network, Intelligent Operator

This document is the foundational philosophy of newtcon. It is the
**authoritative** statement of what newtcon is for and how it must
relate to the operator. `CLAUDE.md` §Operator Philosophy is a
derivative summary; this document is the source.

When this document and any other newtcon document disagree, this
document wins.

## The principle

newtron makes the network intelligent — automated, self-managing,
reasoning about its own state through intent records, replay,
projection, and drift detection. newtcon presents that intelligent
network to the operator. The principle that governs how newtcon does
so is non-negotiable:

> **The automation must make the operator MORE capable, not less.**

The autopilot analogy is exact. An autopilot that produces pilots who
cannot fly the plane when the autopilot fails is a defect, regardless
of how well the autopilot performs when it is working. A network
automation tool that produces operators who cannot operate the network
manually when the automation fails has the same defect.

This is not a UX principle. It is a fundamental statement about what
the tool is for. **newtcon's job is not to complete tasks for the
operator. Its job is to make the operator more capable than the same
operator without it** — measured over months of use, not minutes.

## Vocabulary: what "the substrate" means in this document

Throughout this document, **the substrate** means the canonical typed
data that newtron and newtrun expose over HTTP: **CONFIG_DB entries,
intent records, ChangeSets, projection snapshots, verify assertions,
observation snapshots, and per-write operation records.** Those are the
network engineer's working categories — what the device holds, what the
automation intends, what changed, what was attempted, what landed —
named once so the rest of the document can refer to them collectively.

The term is project-specific; the categories are not. A network engineer
who reads "CONFIG_DB entry" pictures a Redis hash on the device; who
reads "intent record" pictures the automation's stated goal for the
device; who reads "ChangeSet" pictures the delta about to be applied;
who reads "projection snapshot" pictures the automation's current best
read of device state. The substrate is the union of those things and a
few more — observation snapshots over time, verify assertions after a
write, per-write operation records the device returned. When this
document says "the substrate" without further qualification, those are
the categories under discussion.

The substrate is what the operator inspects, queries, and acts against
when working with the automation. The next section's litmus test, and
the nine invariants below, all turn on whether the substrate is legible
to the operator.

## The litmus test

An operator who uses newtcon for a year must be **more capable** than
they were when they started. The strongest expression of "more
capable" is operators who file PRs at the method level, not tickets at
the symptom level. They can run the failed write manually against the
device, isolate device-vs-automation, name the method in the
automation that produced the wrong config, and propose a fix.
Operators who do that have become participants in the automation, not
its consumers.

- **More capable** → philosophy honored.
- **Equally capable** → newtcon was a productivity tool, not a
  capability amplifier. Partial credit, missed opportunity.
- **Less capable** → newtcon has failed its purpose. It has produced
  an operator who depends on the tool to do their job. That is the
  autopilot that grounds its pilots.

This test is binding on every design decision. When proposing a
contract change, adding a surface, or shaping an operator interaction,
the operating question is: **does this make the operator more capable,
or does it create dependency?**

## What this philosophy rejects

newtcon does not follow patterns that produce dependency, regardless
of how well they perform on conventional UX metrics:

- **Wizards that walk the operator through obvious steps.** They
  atrophy the operator's ability to choose their own path.
- **"Friendly" errors that hide information.** "An error occurred"
  teaches nothing. "CONFIG_DB write to key K rejected: schema requires
  field F" teaches the operator about the substrate.
- **Status-light dashboards as the primary surface.** Green/red lights
  reduce rich substrate to abstractions that don't teach. They tell
  the operator something is wrong without teaching them what wrongness
  means.
- **"Just trust it" automation.** Automation whose internals the
  operator cannot inspect produces operators who cannot intervene when
  it fails.
- **Hidden complexity as a feature.** Complexity exists; hiding it
  produces operators who don't know it exists. Exposing it navigably
  produces operators who can navigate it.
- **Magic that cannot be reproduced manually.** Anything newtcon does
  that the operator cannot do by hand is a deficiency, not a feature.

## What this philosophy demands — the nine invariants

Every design decision in newtcon must honor these. The Architect cites
them in every Contract PR. The Architecture Reviewer checks each PR
against them.

### 1. No black boxes

Every automated action is fully inspectable. Click any output and get
the input + principle + decision that produced it. ChangeSets,
intents, projection updates, drift assessments — all shown in full,
not summarized. The operator never has to take a result on faith.

### 2. Manual-mode parity

Anything the automation can do, the operator can do by hand using their existing tools (ssh + redis-cli + vendor CLI + console) directly against the device, **without newtron or newtcon in the path**. newtcon's contribution to manual-mode parity is to **teach** the device-level equivalent of every automated operation and to **expose** the substrate (CONFIG_DB tables, keys, fields, device addresses, vendor doc links) so the operator can act independently.

newtcon does NOT provide a "manual mode," an "escape hatch," an embedded terminal, or any path that mediates device access. It would not be parity if the manual path required newtcon, because newtcon being unavailable is one of the failure modes parity exists to handle. The manual capability must be in the operator's own tools, not in newtcon's affordances.

### 3. The substrate is the teaching surface

Reading the substrate — intent records, projection, drift state,
pipeline traces, ChangeSets — is *how* the operator builds the mental
model of the network. newtcon makes the substrate legible, navigable,
and queryable. It is not abstracted away in service of "simpler"
presentation.

### 4. Show before do (preview with semantics, not just diffs)

Every state-changing action shows what it will do, in operator-facing
domain terms, before doing it. Not just "here is the ChangeSet" but
"here is what this ChangeSet means, here is why it has this shape,
here is what doing it manually would look like."

### 5. Why-mode is always available

Every element of the UI is navigable to its rationale: why this VRF
exists, why this service includes this peer-group, why this drift
card exists, why this verify stage is still in flight. Each "why"
links to the substrate-level cause and to the principle (in
`DESIGN_PRINCIPLES_NEWTRON`, this document, or `CLAUDE.md`) that
governs it.

### 6. Rehearsal mode is real

A safe sandbox where the operator can practice manual control without
affecting reality. Operations in rehearsal mode are explicitly
marked, no real device is touched, and the operator's actions are
shown alongside what the automation would have done. Used for
training, drills, and pre-flight before high-stakes changes.

Rehearsal is non-negotiable. Manual-takeover-readiness without
rehearsal is theoretical, and theoretical readiness is exactly the
autopilot whose pilots cannot fly when it fails.

### 7. Errors carry the substrate

Failures are explained at the level the operator would see if doing
the operation manually. A failed daemon notification, a schema
rejection, a verification mismatch — surfaced with their
substrate-level cause, not a friendly summary that loses information.

### 8. Operator-defined automation, not tool-imposed automation

When operators want a repeated pattern automated, they encode it as
policy themselves. The policy is visible and editable. The automation
is the operator's, not the tool's. "Magic" automations the operator
cannot author or edit are autopilots whose internals the pilot can't
see — precisely what this philosophy rejects.

### 9. Confidence and limits are explicit

The tool acknowledges what it knows and what it doesn't. When
automation is certain, it acts. When uncertain, it proposes and
waits. When outside its competence, it escalates. False confidence is
worse than no confidence because it teaches the operator to
over-trust.

## Concrete success vision: operators as participants

The philosophy can sound abstract. A concrete vision of success makes
it operational. The strongest expression of capability amplification
is operators who become **participants in the automation, not
consumers of it.**

- The operator sees changes executing **in real time** — each write to
  the device as it lands, not just "operation complete." Streaming
  per-write visibility, not aggregate success.
- When the device rejects a change, the operator sees **exactly which
  write failed**, what was attempted, and what the device returned.
  Per-write granularity on failures, not aggregate error.
- The operator can take the failed write and try it manually against
  the device themselves, **isolating device-vs-automation**. The
  failed write is shown in copy-paste-ready form; the operator's own
  ssh session is the venue.
- The operator can point at the **exact method in the automation**
  that produced the bad config. In verbose mode, every write carries
  the call-site (file:line / function name) of the automation method
  that emitted it. The operator learns the names of the automation's
  parts.
- The operator **files a PR** against the automation, not a ticket.
  They name the method, propose the fix. The automation team accepts
  the patch.

When this is working, the operator has become a co-developer of the
automation. They identify bugs at the method level, isolate failures
to either device or automation, and contribute back. This is the
strongest form of capability amplification: not just "more capable at
network operations" but "more capable at improving the tool itself."

## Aesthetic discipline: beautiful, elegant, simple AND powerful

The nine invariants above describe what newtcon must **do**. This section
describes how it must **feel**. Both are non-negotiable.

A tool that exposes the substrate without aesthetic discipline produces
an interface that is technically correct but ugly, dense, and
intimidating. Operators avoid such tools, or use them under duress, and
the capability amplification this philosophy demands cannot happen
through a tool the operator dislikes. Substrate exposure is necessary;
beauty is necessary; neither alone is sufficient.

A tool that is aesthetically refined but shallow produces another
pretty-but-empty interface — Apstra with better fonts. Beauty without
substrate exposure produces dependency, not capability. The operator
enjoys using the tool but does not learn through it.

newtcon must be **both**. The first sight of any surface must be calm,
inviting, and elegant; depth must be one navigation step away and
visually delightful when reached.

### What aesthetic discipline demands

- **Typography is load-bearing.** Type choices carry meaning: domain
  vocabulary in one face, identifiers in another, code in a third.
  Sizes and weights establish hierarchy without ornament.
- **Color is semantic, not decorative.** A small palette. Each color
  has a meaning the operator can name; no decorative use of color
  anywhere.
- **Whitespace is generous and intentional.** Information has room to
  breathe. Density is opt-in, never the default surface.
- **Motion carries information.** Pipeline stages flow visibly;
  ChangeSet previews materialize as targets are selected. Motion is
  never decorative.
- **Visual hierarchy carries semantic hierarchy.** The most important
  thing on a screen is the most prominent visually. Substrate is one
  click away, not in your face.
- **Density is layered.** Surface view: calm, elegant. One step in:
  more detail. One step further: full substrate. The operator chooses
  depth.
- **Empty states are designed.** Not "no data" but "nothing here yet
  because [reason]; here is what would appear if [condition]."
- **Performance is part of aesthetics.** Lag is ugly. Interactions
  must be immediate; long operations must show their pipeline in
  motion, not freeze.
- **Consistency.** A small vocabulary of visual elements, used
  consistently — just as newtron has a small vocabulary of concepts.

### Simplicity and power

The operator must perceive newtcon as **simple to use, powerful when
needed**. Not simple OR powerful — both, at the same time, layered.

- **Simple at first sight.** The default surface for any task is the
  minimum: one input, one output, no clutter. The operator never has
  to wade through controls to find the one they need.
- **Powerful one step in.** The full capability is one navigation step
  away. Power-user shortcuts (keyboard navigation, command palette,
  structured queries) are present and discoverable but never required
  to accomplish the basic task.
- **No "advanced mode" toggle.** Power is layered into the interface,
  not gated behind a switch. The operator's growing expertise reveals
  more affordances naturally as they use them.

### The aesthetic litmus test

Alongside the capability litmus test (a year of use must leave the
operator more capable), apply the aesthetic litmus test:

> **Does the operator want to open this tool?**

If the operator opens newtcon at the start of the day because they look
forward to using it — because it is calm, elegant, and respects their
intelligence — the aesthetic discipline is honored. If the operator
opens newtcon out of obligation, dragging themselves through screens
they find ugly or noisy, the discipline has failed.

A tool the operator does not want to open cannot amplify capability,
no matter how many invariants it nominally honors. The capability
litmus test and the aesthetic litmus test are inseparable.

## Fractal application: philosophy applies to the team, not just the UI

This philosophy applies to every output of the agent team that builds
newtcon, not only to the user-facing UI:

- **Drift Auditor reports** are teaching documents, not compliance
  records. An operator reading them should understand newtcon and
  newtron better afterward, not merely be informed that drift was
  detected.
- **Architect Contract PRs** cite design principles and considered
  alternatives as teaching, not as ritual compliance. A reader of the
  PR history should be learning newtron and newtcon by reading.
- **Critic rejections** are teaching moments. The numbered check that
  failed and why is enough to teach the Implementer; the Implementer
  iterates with more knowledge than they had before.
- **Architecture Reviewer comments** surface alternatives and cite
  newtron principles, so that the Architect learns from each
  exchange, not just iterates.

If the team's outputs make operators (and future contributors) more
capable over time, the team is honoring this philosophy. If outputs
are accurate but opaque — correct but not teaching — the team is
failing it.

## Relationship to other documents

This document is the foundation. It is the **why** behind:

- The design principles in `CLAUDE.md` §Design Principles (which
  operationalize this philosophy at the implementation level).
- The non-goals in `docs/architecture.md` (no topology editor, no
  per-device configurator, no status-dashboard primary surface — all
  derive from this philosophy's rejections).
- The operator surfaces in `API_CONTRACT.md` (Service Composer,
  Operator Inbox, Change Workbench — and the Provenance and
  Rehearsal surfaces that this philosophy demands and that future
  Contract PRs will add).

When this philosophy and a derivative principle disagree, the
philosophy wins, and the derivative is updated to match.

newtron's `DESIGN_PRINCIPLES_NEWTRON.md` is the authoritative source
for **what the network is**. This document is the authoritative
source for **how newtcon presents the network to the operator**.
Together they ground every newtcon design decision.
