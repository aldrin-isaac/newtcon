// test/surfaces/services/services.test.js — unit tests for the services-listing
// surface rendering functions.
//
// Tests run under Node.js's built-in node:test module (web/README.md §Test runner).
// The module under test is imported from dist/ (compiled output of src/).
// DOM globals are provided by test/lib/dom-stub.js.
//
// Tests cover per acceptance criteria 7 + D2 round-2 of newtcon#105:
//   - renderLoading: shows loading text immediately.
//   - renderServices (non-empty): renders name + type only; does not render
//     instance_count, health, or last_modified (invariant #9).
//   - renderServices (empty): spec-correct message + manual-mode parity link.
//   - renderError (newtron_unavailable): surfaces underlying_error + rationale.
//   - renderError (other ApiError): surfaces kind + message + <details>.
//   - renderError (plain Error / network failure): "unreachable from this browser".

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setupDOM, makeRoot } from "../../lib/dom-stub.js";

// Apply DOM stubs before importing the surface module, which references
// browser globals at import time.
setupDOM();

import {
  renderLoading,
  renderServices,
  renderError,
} from "../../../dist/surfaces/services/services.js";

import { ApiError } from "../../../dist/api/newtcon/services.js";

// ---- helpers -------------------------------------------------------------

/** Recursively find a child with a matching className. */
function findByClassDeep(el, className) {
  if (!el || !Array.isArray(el.children)) return null;
  for (const child of el.children) {
    if (!child || !child.tagName) continue; // skip text nodes
    if (child.className && child.className.includes(className)) return child;
    const found = findByClassDeep(child, className);
    if (found) return found;
  }
  return null;
}

/** Collect all tagName occurrences (case-insensitive, recursive). */
function findAllByTag(el, tag) {
  const results = [];
  if (!el || !Array.isArray(el.children)) return results;
  const upper = tag.toUpperCase();
  for (const child of el.children) {
    if (!child || !child.tagName) continue; // skip text nodes
    if (child.tagName === upper) results.push(child);
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

/** Recursively collect all text from an element tree. */
function collectAllText(el) {
  if (!el) return "";
  let text = el._text ?? "";
  for (const child of el.children ?? []) {
    if (child && typeof child._collectText === "function") {
      text += child._collectText();
    } else if (child && child._data !== undefined) {
      text += child._data;
    }
  }
  return text;
}

// ---- tests ---------------------------------------------------------------

describe("renderLoading()", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("clears root and shows loading text", () => {
    // Pre-populate root to verify it is cleared.
    root.children.push({ tagName: "P", _text: "stale", children: [] });

    renderLoading(root);

    // Root should have exactly one child after renderLoading.
    assert.equal(root.children.length, 1);
    const p = root.children[0];
    assert.equal(p.tagName, "P");
    assert.equal(p.className, "status-loading");
  });
});

describe("renderServices() — non-empty list", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  const twoServices = {
    services: [
      {
        name: "core-l3",
        type: "routed",
        instance_count: 0,
        health: { healthy: 0, degraded: 0, failed: 0 },
        last_modified: "0001-01-01T00:00:00Z",
      },
      {
        name: "edge-irb",
        type: "irb",
        instance_count: 0,
        health: { healthy: 0, degraded: 0, failed: 0 },
        last_modified: "0001-01-01T00:00:00Z",
      },
    ],
  };

  test("renders a table element", () => {
    renderServices(root, twoServices);
    const tables = findAllByTag(root, "table");
    assert.equal(tables.length, 1);
  });

  test("renders one row per service in tbody", () => {
    renderServices(root, twoServices);
    const rows = findAllByTag(root, "tr");
    // One header row + two data rows.
    assert.equal(rows.length, 3);
  });

  test("renders name and type cells", () => {
    renderServices(root, twoServices);
    const nameCells = findAllByTag(root, "td").filter(
      (td) => td.className === "svc-name"
    );
    const typeCells = findAllByTag(root, "td").filter(
      (td) => td.className === "svc-type"
    );
    assert.equal(nameCells.length, 2);
    assert.equal(typeCells.length, 2);

    // Verify cell content.
    assert.equal(nameCells[0]._text, "core-l3");
    assert.equal(typeCells[0]._text, "routed");
    assert.equal(nameCells[1]._text, "edge-irb");
    assert.equal(typeCells[1]._text, "irb");
  });

  test("does NOT render instance_count, health, or last_modified", () => {
    renderServices(root, twoServices);
    // All td elements must be svc-name or svc-type — no other column present.
    const allCells = findAllByTag(root, "td");
    for (const td of allCells) {
      assert.ok(
        td.className === "svc-name" || td.className === "svc-type",
        `unexpected td class: "${td.className}"`
      );
    }
  });

  test("renders pending-note about zero-valued aggregates", () => {
    renderServices(root, twoServices);
    const note = findByClassDeep(root, "pending-note");
    assert.ok(note !== null, "pending-note element should be present");
  });
});

describe("renderServices() — empty list", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders empty-state container when services list is empty", () => {
    renderServices(root, { services: [] });
    const empty = findByClassDeep(root, "state-empty");
    assert.ok(empty !== null, "state-empty element should be present");
  });

  test("does not render a table when services list is empty", () => {
    renderServices(root, { services: [] });
    const tables = findAllByTag(root, "table");
    assert.equal(tables.length, 0);
  });

  test("renders spec-correct empty-state message", () => {
    renderServices(root, { services: [] });
    const empty = findByClassDeep(root, "state-empty");
    assert.ok(empty !== null);
    const text = empty._collectText();
    assert.ok(
      text.includes("No service specs registered in this newtron network."),
      `empty-state text should include spec message; got: "${text}"`
    );
  });

  test("renders manual-mode parity link in empty state", () => {
    renderServices(root, { services: [] });
    const note = findByClassDeep(root, "note");
    assert.ok(note !== null, "note element with manual-mode link should be present");
    // The innerHTML of the note includes the manual-mode parity anchor href.
    assert.ok(
      note.innerHTML && note.innerHTML.includes("manual-mode-parity"),
      `note innerHTML should contain manual-mode-parity link; got: "${note.innerHTML}"`
    );
  });
});

describe("renderError() — newtron_unavailable (503)", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders state-error container", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: { underlying_error: "connection_refused" },
      },
    });
    renderError(root, apiErr);
    assert.ok(findByClassDeep(root, "state-error") !== null);
  });

  test("surfaces kind newtron_unavailable verbatim", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: {},
      },
    });
    renderError(root, apiErr);
    const kindEl = findByClassDeep(root, "error-kind");
    assert.ok(kindEl !== null, "error-kind element should be present");
    const text = kindEl._collectText();
    assert.ok(
      text.includes("newtron_unavailable"),
      `error-kind text should include kind; got: "${text}"`
    );
  });

  test("surfaces underlying_error from details", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: { underlying_error: "connection_refused" },
      },
    });
    renderError(root, apiErr);
    const substrate = findByClassDeep(root, "error-substrate");
    assert.ok(substrate !== null, "error-substrate element should be present");
    const text = substrate._collectText();
    assert.ok(
      text.includes("connection_refused"),
      `error-substrate should include underlying_error; got: "${text}"`
    );
  });

  test("surfaces next_action_hint.rationale from details", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: {
          underlying_error: "connection_refused",
          next_action_hint: {
            rationale: "check /api/health to see current newtron-server reachability status",
          },
        },
      },
    });
    renderError(root, apiErr);
    const rationale = findByClassDeep(root, "error-rationale");
    assert.ok(rationale !== null, "error-rationale element should be present");
    const text = rationale._collectText();
    assert.ok(
      text.includes("check /api/health"),
      `error-rationale should include rationale text; got: "${text}"`
    );
  });

  test("renders error-hint with /api/health link", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: {},
      },
    });
    renderError(root, apiErr);
    const hint = findByClassDeep(root, "error-hint");
    assert.ok(hint !== null, "error-hint element should be present");
  });
});

describe("renderError() — other ApiError (non-503)", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders state-error container", () => {
    const apiErr = new ApiError(500, {
      error: {
        kind: "internal",
        message: "unexpected error",
        details: { correlation_id: "abc123" },
      },
    });
    renderError(root, apiErr);
    assert.ok(findByClassDeep(root, "state-error") !== null);
  });

  test("surfaces kind and message verbatim", () => {
    const apiErr = new ApiError(500, {
      error: {
        kind: "internal",
        message: "unexpected error occurred",
        details: {},
      },
    });
    renderError(root, apiErr);
    const kindEl = findByClassDeep(root, "error-kind");
    assert.ok(kindEl !== null);
    const kindText = kindEl._collectText();
    assert.ok(kindText.includes("internal"), `kind text: "${kindText}"`);

    const msgEl = findByClassDeep(root, "error-message");
    assert.ok(msgEl !== null);
    const msgText = msgEl._collectText();
    assert.ok(
      msgText.includes("unexpected error occurred"),
      `message text: "${msgText}"`
    );
  });

  test("renders error-details element with HTTP status", () => {
    const apiErr = new ApiError(422, {
      error: {
        kind: "validation_failure",
        message: "field x required",
        details: { field: "x" },
      },
    });
    renderError(root, apiErr);
    const details = findByClassDeep(root, "error-details");
    assert.ok(details !== null, "error-details element should be present");
    // The summary should contain the HTTP status code.
    const summaries = findAllByTag(details, "summary");
    assert.ok(summaries.length > 0, "details element should have a summary");
    const summaryText = summaries[0]._collectText();
    assert.ok(
      summaryText.includes("422"),
      `summary should include HTTP status; got: "${summaryText}"`
    );
  });
});

describe("renderError() — plain Error (network / browser failure)", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders state-error container for plain Error", () => {
    renderError(root, new Error("Failed to fetch"));
    assert.ok(findByClassDeep(root, "state-error") !== null);
  });

  test("renders 'network error' kind for plain Error", () => {
    renderError(root, new Error("Failed to fetch"));
    const kindEl = findByClassDeep(root, "error-kind");
    assert.ok(kindEl !== null);
    const text = kindEl._collectText();
    assert.ok(text.includes("network error"), `kind text: "${text}"`);
  });

  test("renders 'unreachable from this browser' message for plain Error", () => {
    renderError(root, new Error("Failed to fetch"));
    const msgEl = findByClassDeep(root, "error-message");
    assert.ok(msgEl !== null);
    const text = msgEl._collectText();
    assert.ok(
      text.includes("unreachable from this browser"),
      `message should distinguish browser→newtcon hop; got: "${text}"`
    );
  });

  test("renders raw error message in error-raw for plain Error", () => {
    renderError(root, new Error("net::ERR_CONNECTION_REFUSED"));
    const rawEl = findByClassDeep(root, "error-raw");
    assert.ok(rawEl !== null, "error-raw element should be present");
    const text = rawEl._collectText();
    assert.ok(
      text.includes("ERR_CONNECTION_REFUSED"),
      `error-raw should include raw message; got: "${text}"`
    );
  });
});
