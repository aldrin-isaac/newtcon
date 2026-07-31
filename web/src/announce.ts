// announce.ts — the polite live region for state changes that have no visible
// text of their own to announce.
//
// Toasts already carry their own live region (toast.ts creates .toast-region
// with role="status" + aria-live="polite"), so anything surfaced as a toast is
// covered. This is for the quieter signals a sighted operator reads from the
// chrome but a screen-reader user would otherwise never hear — chiefly the
// pending-changes count, which changes as a side effect of acting elsewhere on
// the page.
//
// Deliberately polite, never assertive: staging a change must not interrupt
// whatever the operator is reading. One shared region, created lazily.

const REGION_ID = "a11y-announcer";

function region(): HTMLElement {
  const existing = document.getElementById(REGION_ID);
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = REGION_ID;
  el.className = "sr-only"; // the design system's existing hidden utility
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  document.body.appendChild(el);
  return el;
}

let last = "";

/** announce — say `message` politely, once. Repeating the identical string is
 *  a no-op: re-announcing "3 pending changes" on every unrelated re-render
 *  would make the region chatter. */
export function announce(message: string): void {
  if (message === last) return;
  last = message;
  region().textContent = message;
}
