// focus-scope.ts — moving keyboard focus into a surface and giving it back.
//
// Two different needs, deliberately not conflated:
//
//   TRAP (modals) — the command palette and the sign-in overlay are
//   role="dialog" aria-modal="true". Nothing behind them is reachable, so Tab
//   must cycle within them.
//
//   NO TRAP (the drawer) — the device/spec drawer is NOT modal: at ≥1400px it
//   docks as a grid column beside the workspace (workspace.css, uplift 2.5) and
//   the operator can legitimately tab back out to the canvas. Trapping there
//   would be a cage, not an affordance. It still needs focus moved IN on open
//   and returned on close, which is the half that was missing.
//
// Both cases restore focus to whatever was focused before — otherwise closing a
// surface drops focus to <body> and a keyboard operator loses their place.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    // getClientRects() is the honest visibility test here: offsetParent is null
    // for position:fixed elements, which the palette and overlays are.
    .filter((el) => el.getClientRects().length > 0);
}

export interface FocusScopeOpts {
  /** Cycle Tab within the container. Only for genuinely modal surfaces. */
  trap?: boolean;
  /** What to focus on entry. Defaults to the first focusable descendant. */
  initial?: HTMLElement | null;
}

/**
 * enterFocusScope — move focus into `container` and return a release function
 * that restores focus to wherever it was. Call the returned function exactly
 * once, when the surface closes.
 */
export function enterFocusScope(container: HTMLElement, opts: FocusScopeOpts = {}): () => void {
  const previous = document.activeElement as HTMLElement | null;

  let onKeydown: ((e: KeyboardEvent) => void) | null = null;
  if (opts.trap) {
    onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const items = focusable(container);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !container.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase so the trap wins over any inner Tab handling.
    document.addEventListener("keydown", onKeydown, true);
  }

  const target = opts.initial ?? focusable(container)[0] ?? null;
  target?.focus();

  return (): void => {
    if (onKeydown) document.removeEventListener("keydown", onKeydown, true);
    // Only restore to something still in the document — the element that
    // opened the surface may itself have been re-rendered away.
    if (previous && previous.isConnected) previous.focus();
  };
}
