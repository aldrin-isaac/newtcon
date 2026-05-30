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
// At the F1 scaffold stage the only surface is the loading placeholder
// in index.html; this module is a stub that will be extended by F2
// (newtcon#105) when the services-listing surface lands.
//
// Import paths use .js extensions per the node16 moduleResolution rule
// documented in web/README.md: tsc emits .js files; the browser loads
// .js files; the import paths must match what the browser loads.

// No imports yet — F2 populates web/src/api/newtcon/ and the first
// surface module.

/**
 * bootstrap is called once the module loads. At F1 scaffold stage it is a
 * no-op placeholder; F2 will replace the body with surface dispatch.
 */
function bootstrap(): void {
  // Intentionally empty at scaffold stage.
  // F2 (newtcon#105) will add surface dispatch here once
  // web/src/surfaces/ contains at least one surface module.
}

bootstrap();
