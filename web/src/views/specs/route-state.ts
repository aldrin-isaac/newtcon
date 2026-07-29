// views/specs/route-state.ts — how the Specs view announces navigation state
// to the router (uplift 2.4).
//
// Views don't own the URL; router.ts does. A view reports a partial params
// change by dispatching "newtcon:route-state" on document and the router folds
// it into the hash. Fire-and-forget: with no router listening (unit tests) the
// event is inert.
//
// Lives in its own file because both detail.ts (open/close a spec drawer) and
// index.ts (facet subnav clicks) announce, and a shared announce is the one
// place that knows the event name.

/** announceRoute — tell the router about a params change so the URL hash
 *  tracks workspace state. */
export function announceRoute(detail: Record<string, string | null>): void {
  document.dispatchEvent(new CustomEvent("newtcon:route-state", { detail }));
}
