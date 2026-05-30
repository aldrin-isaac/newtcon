// app.ts — newtcon browser frontend entry module.
//
// This module is the <script type="module"> entry point referenced by
// web/src/index.html. It runs in the browser after the HTML shell has
// rendered and is responsible for initialising the active surface.
//
// Surface routing is deliberate, not file-based. Each top-level surface
// is a plain TypeScript module under web/src/surfaces/; this entry
// module selects the surface from window.location.pathname and calls
// its mount() function. The router is ~10 lines of plain code — there
// is no client-side routing framework.
//
// At F2 the router handles one surface: services-listing at /. A second
// entry point (surfaces/services/index.html with its own inline <script>)
// serves the services page directly; this module serves the root index.html
// redirect strategy (see landing-page strategy in PR body).
//
// Import paths use .js extensions per the node16 moduleResolution rule
// documented in web/README.md: tsc emits .js files; the browser loads
// .js files; the import paths must match what the browser loads.

/**
 * bootstrap selects the active surface from window.location.pathname and
 * mounts it. At F2 the only surface is services-listing, which is served
 * at /surfaces/services/index.html. The root / redirects there via the
 * meta-refresh in index.html; no client-side routing is needed for a
 * single surface.
 *
 * When a second surface arrives (Provenance drill-down per F-next), this
 * function will grow a path-dispatch table — still ~10 lines, still no
 * framework. The ADR-0002 §Consequences note on routing applies at that
 * point.
 */
function bootstrap(): void {
  // Root: redirect to the services surface. The meta-refresh in index.html
  // handles the initial load; this code path handles in-app navigation back
  // to "/" if it ever arises (e.g., nav-link click).
  if (window.location.pathname === "/" || window.location.pathname === "") {
    window.location.replace("/surfaces/services/");
  }
  // Additional surface dispatch entries land here as surfaces are added.
}

bootstrap();
