// dom-stub.js — minimal DOM stub for unit-level rendering tests run under
// Node.js's built-in node:test module.
//
// Browser globals used by web/src/ modules are shimmed here so that tests can
// import compiled dist/ modules and exercise rendering logic without a full
// browser or jsdom. Only the surface area actually used by newtcon's modules
// is stubbed; this is NOT a complete DOM implementation.
//
// Usage in a test file:
//
//   import "./lib/dom-stub.js";   // apply stubs before importing the module
//   import { renderServiceRow } from "../../dist/surfaces/services/row.js";
//
// F1 scaffold: the stub exports a no-op setupDOM() for now. Concrete stubs
// (document.createElement, document.getElementById, etc.) are added here as
// F2/F3 surfaces arrive and their tests reveal which globals are needed.

/**
 * setupDOM installs minimal browser globals on the Node.js global object.
 * Call at the top of any test file that imports modules using browser APIs.
 *
 * At F1 scaffold stage this is a no-op; the function exists so that future
 * test files can unconditionally call `setupDOM()` without needing to check
 * whether it has been populated.
 */
export function setupDOM() {
  // Populated incrementally as surfaces under web/src/surfaces/ and
  // web/src/workflows/ require specific globals. The canonical pattern:
  //
  //   if (typeof globalThis.document === "undefined") {
  //     globalThis.document = { createElement: ..., getElementById: ... };
  //   }
}
