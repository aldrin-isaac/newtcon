// test/surfaces/services/services.test.js — unit tests for the services-listing
// surface rendering functions.
//
// Tests run under Node.js's built-in node:test module (web/README.md §Test runner).
// The module under test is imported from dist/ (compiled output of src/).
// DOM globals are provided by test/lib/dom-stub.js.
//
// Tests cover per acceptance criterion 7 of newtcon#105:
//   - renderLoading: shows loading text immediately.
//   - renderServices (non-empty): renders name + type only; does not render
//     instance_count, health, or last_modified (invariant #9).
//   - renderServices (empty): renders empty-state message.
//   - renderError (ApiError): surfaces kind and message verbatim.
//   - renderError (plain Error): surfaces message, no ApiError fields.

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

/** Collect all text content recursively from a StubElement tree. */
function collectText(el) {
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

/** Find the first child with a matching className (shallow). */
function findByClass(el, className) {
  return el.children.find(
    (c) => c.className === className || (c.className && c.className.includes(className))
  );
}

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

/** Collect all tagName occurrences (case-insensitive). */
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
    // Collect all text recursively — none should mention instance counts or
    // health numeric values.
    const allCells = findAllByTag(root, "td");
    for (const td of allCells) {
      // There should be no "0" standing alone as instance count display.
      // Cells should only be svc-name or svc-type.
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
});

describe("renderError() — ApiError", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders state-error container", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable",
        details: {},
      },
    });
    renderError(root, apiErr);
    const box = findByClassDeep(root, "state-error");
    assert.ok(box !== null, "state-error element should be present");
  });

  test("surfaces error kind verbatim", () => {
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
    // The text should contain the kind value.
    const text = kindEl._collectText();
    assert.ok(
      text.includes("newtron_unavailable"),
      `error-kind text should include kind; got: "${text}"`
    );
  });

  test("surfaces error message verbatim", () => {
    const apiErr = new ApiError(503, {
      error: {
        kind: "newtron_unavailable",
        message: "newtron-server unreachable during listing services",
        details: {},
      },
    });
    renderError(root, apiErr);
    const msgEl = findByClassDeep(root, "error-message");
    assert.ok(msgEl !== null, "error-message element should be present");
    const text = msgEl._collectText();
    assert.ok(
      text.includes("newtron-server unreachable"),
      `error-message text should include message; got: "${text}"`
    );
  });
});

describe("renderError() — plain Error (network failure)", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  test("renders state-error container for plain Error", () => {
    renderError(root, new Error("network error reaching newtcon-server: ECONNREFUSED"));
    const box = findByClassDeep(root, "state-error");
    assert.ok(box !== null);
  });

  test("surfaces error message for plain Error", () => {
    renderError(root, new Error("network error reaching newtcon-server: ECONNREFUSED"));
    const msgEl = findByClassDeep(root, "error-message");
    assert.ok(msgEl !== null);
    const text = msgEl._collectText();
    assert.ok(text.includes("ECONNREFUSED"), `message text: "${text}"`);
  });

  test("kind element shows 'network error' for plain Error", () => {
    renderError(root, new Error("timeout"));
    const kindEl = findByClassDeep(root, "error-kind");
    assert.ok(kindEl !== null);
    const text = kindEl._collectText();
    assert.ok(text.includes("network error"), `kind text: "${text}"`);
  });
});
