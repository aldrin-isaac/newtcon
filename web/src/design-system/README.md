# newtcon design system

Five CSS files that define the visual vocabulary for every newtcon surface.
All tokens are CSS custom properties (variables) on `:root`.

> **This file is normative for token NAMES.** If a name here doesn't resolve,
> that's a bug in this document — check the `.css` file and fix the doc in the
> same PR. An undefined `var()` fails silently, so a stale name here costs a
> contributor real debugging time.

## Files

| File | What it defines |
|------|-----------------|
| `color.css` | Semantic color roles, light + dark |
| `typography.css` | Three font stacks, nine type sizes, four line heights, the two measures |
| `spacing.css` | Nine spacing steps (t-shirt scale) |
| `motion.css` | Four easing curves, six duration tokens |
| `components.css` | Shared primitives (chip, `.sr-only`, `.skip-link`, focus ring) |

Each surface imports the four files it needs. A surface-specific stylesheet
then writes rules in terms of those tokens — no raw hex values, no raw pixel
sizes outside the token scale.

## Colors

Color is organised as ROLE FAMILIES, not a fixed count. Each family has one
meaning; within a family, suffixes are steps of the same idea. No color is
decorative, and no rule outside `color.css` may write a raw hex value (the
`raw_colors_workspace` ratchet enforces this at 0).

| Family | Role |
|--------|------|
| `--color-bg-*` | Page + app-shell backgrounds |
| `--color-surface-*` | Raised planes: cards, header, drawer, hover states |
| `--color-text-*` | `primary` / `secondary` / `muted` / `inverse` |
| `--color-border-*` | `subtle` / `default` / `strong` |
| `--color-accent-*` | Interactive + active state |
| `--color-success-*`, `--color-warning-*`, `--color-danger-*`, `--color-info-*` | Status |
| `--color-drift-*` | Intent-vs-reality divergence — its own signal, not a warning |
| `--color-terminal-*` | Log + console surfaces |
| `--color-focus-ring` | The one focus indicator |
| `--color-scrim` | Modal/overlay backdrop |

The discipline is not a numeric cap — it's that every color the operator sees
has a role they can state. "Accent" means interactive. "Drift" means intent and
reality disagree. Nothing is "blue-ish for variety."

## Typography

Three font stacks:

- `--font-system` — domain vocabulary, navigation, prose. System typeface.
- `--font-mono` — substrate values: type badges, error codes, inline code.
  Leads with **JetBrains Mono** (vendored woff2 in `fonts/`, OFL-1.1 — license
  alongside), falling back to the system mono stack while it loads
  (`font-display: swap`). Fixed-width digits make it the guarantee behind
  "live numbers never shift layout"; `font-variant-numeric: tabular-nums` on
  `body` extends that to proportional text on platforms whose fonts ship `tnum`.
  Signals "this is a value you can copy and use in a terminal."
- `--font-display` — page-level headings only, where a distinct voice earns
  its keep. Never for body copy.

Nine type sizes, `--text-2xs` (0.6875rem) through `--text-display` (2.25rem).
Match each size to its semantic role, not to a visual preference:

- `--text-2xs` — dense table cells, canvas labels
- `--text-xs` — column headers (uppercase, letter-spaced)
- `--text-sm` — badges, footnotes, secondary labels, error detail lines
- `--text-base` — body text, table cells, primary prose
- `--text-md` / `--text-lg` — section headings
- `--text-xl` / `--text-2xl` — page-level headings
- `--text-display` — the one hero size; sparing

Four line heights: `--leading-tight` / `--leading-snug` / `--leading-normal` /
`--leading-prose`.

## Spacing

A 4px-derived t-shirt scale, `--space-3xs` (2px) through `--space-3xl` (64px):
2 / 4 / 6 / 10 / 16 / 24 / 32 / 48 / 64. Use scale values only — no ad-hoc
rem/px in layout rules. If nothing fits, extend the scale in a PR that says why.

Two content-width measures (declared in `typography.css`, since they're
reading-length constraints):
- `--measure-prose` — 65ch for readable prose lines (subtitles, error messages)
- `--measure-page` — 88rem for the main column

## Motion

Four easing curves (`--ease-standard` / `--ease-decelerate` / `--ease-accelerate`
/ `--ease-spring`) and six duration tokens. Motion carries information; it is
never decorative:

- `--duration-instant` (80ms): focus rings, immediate affordance feedback
- `--duration-fast` (120ms): hover highlights
- `--duration-base` (180ms): content fade-in (loading to resolved)
- `--duration-slow` (240ms): larger content transitions
- `--duration-drawer` (280ms): the drawer slide
- `--duration-slower` (360ms): the longest deliberate move

All durations collapse to 0ms under `prefers-reduced-motion: reduce`.

## How to extend

Adding a new token to any of these files is an Architecture-class PR.
The Architect must defend:

- Why the existing tokens cannot cover the new need.
- Why this token belongs in the design system (shared across surfaces)
  rather than as a one-off in a surface-specific stylesheet.

The discipline of "restraint" means the cost of extension is intentionally
higher than the cost of reuse. Reach for an existing token first.
