# newtcon design system

Four CSS files that define the visual vocabulary for every newtcon surface.
All tokens are CSS custom properties (variables) on `:root`.

## Files

| File | What it defines |
|------|-----------------|
| `color.css` | Six named semantic colors |
| `typography.css` | Three font stacks, five type sizes, three line heights |
| `spacing.css` | Seven spacing steps plus two content-width measures |
| `motion.css` | Two easing curves, three duration tokens |

Each surface imports the four files it needs. A surface-specific stylesheet
then writes rules in terms of those tokens — no raw hex values, no raw pixel
sizes outside the token scale.

## Colors

Six semantic colors. Each has one meaning; no color is decorative.

| Token | Role |
|-------|------|
| `--color-surface` | Base page background |
| `--color-surface-elevated` | Header, footer, cards — creates depth without noise |
| `--color-text-primary` | All primary content: headings, table cells, labels |
| `--color-text-secondary` | Supporting text: subtitles, column headers, status indicators |
| `--color-accent` | Links, active nav indicator, type badges, inline code backgrounds |
| `--color-danger` | Error containers only — intentionally muted, not alarm-red |

The cap is six. Restraint is the discipline: every color the operator sees should
have a name they can state. "Accent" means interactive or type-distinguishing.
"Danger" means attention needed. No color should be "blue-ish for variety."

## Typography

Three font stacks:

- `--font-sans` — domain vocabulary, navigation, prose. System typeface.
- `--font-mono` — substrate values: type badges, error codes, inline code.
  Signals "this is a value you can copy and use in a terminal."
- `--font-ui` — currently `--font-sans`; split reserved for a future ADR.

Five type sizes (`--text-xs` through `--text-xl`). Match each size to its
semantic role, not to an arbitrary visual preference:

- `--text-xs` — column headers (uppercase, letter-spaced)
- `--text-sm` — badges, footnotes, secondary labels, error detail lines
- `--text-base` — body text, table cells, primary prose
- `--text-lg` — reserved for section headings
- `--text-xl` — page-level `<h1>`

## Spacing

A 4px-base numeric scale (`--space-1` through `--space-8`). Use scale values
only — no ad-hoc rem/px values in layout rules. If no scale value fits, file an
Architecture-class PR to extend the scale.

Two content-width measures:
- `--measure-prose` — 60ch for readable prose lines (subtitles, error messages)
- `--measure-page` — 72rem for the main column

## Motion

Two easing curves and three duration tokens. Motion carries information; it
is never decorative. The rules:

- `--duration-fast` (80ms): hover highlights, focus rings
- `--duration-base` (160ms): content fade-in (loading to resolved)
- `--duration-slow` (300ms): reserved for panel slides in future surfaces

All durations collapse to 0ms under `prefers-reduced-motion: reduce`.

## How to extend

Adding a new token to any of these files is an Architecture-class PR.
The Architect must defend:

- Why the existing tokens cannot cover the new need.
- Why this token belongs in the design system (shared across surfaces)
  rather than as a one-off in a surface-specific stylesheet.

The discipline of "restraint" means the cost of extension is intentionally
higher than the cost of reuse. Reach for an existing token first.
