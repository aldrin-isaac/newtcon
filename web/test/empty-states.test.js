// test/empty-states.test.js — unit tests for the curated empty-state
// copy (slice #169.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { emptyStateFor, hasEmptyState } from "../dist/empty-states.js";

// The kinds covered by the curated COPY map. Keep this list in sync
// with COPY in empty-states.ts so a missing or added entry is caught
// by the tests rather than silently shipping.
const CURATED_KINDS = [
  "services", "ipvpns", "macvpns",
  "qos-policies", "filters", "prefix-lists", "route-policies",
  "profiles", "zones", "platforms",
];

describe("emptyStateFor() — curated kinds", () => {
  for (const kind of CURATED_KINDS) {
    test(`${kind} has a non-empty title + body`, () => {
      const c = emptyStateFor(kind);
      assert.ok(c.title && c.title.length > 0, "title should be non-empty");
      assert.ok(c.body && c.body.length > 0, "body should be non-empty");
    });
  }

  test("services hint mentions creating IP / MAC VPN first (operator workflow)", () => {
    const c = emptyStateFor("services");
    assert.ok(c.hint && /IP VPN|MAC VPN/.test(c.hint));
  });

  test("profiles hint flags topology dependency", () => {
    const c = emptyStateFor("profiles");
    assert.ok(c.hint && /Topology|topology/.test(c.hint));
  });

  test("platforms hint admits the not-yet-editable constraint honestly", () => {
    const c = emptyStateFor("platforms");
    assert.ok(c.hint && /not editable|network\.json/.test(c.hint));
  });
});

describe("emptyStateFor() — operator-language lens", () => {
  test("never references 'spec' (project-internal jargon)", () => {
    // Operator-facing copy should use the operator-domain noun
    // ("service", "IP VPN", "profile") not the project-internal one
    // ("spec"). The headline pattern can mention "defined" but should
    // not say "spec".
    for (const kind of CURATED_KINDS) {
      const c = emptyStateFor(kind);
      const haystack = (c.title + " " + c.body + " " + (c.hint ?? "")).toLowerCase();
      assert.ok(!/\bspec\b/.test(haystack), `${kind} should not use 'spec' in operator copy: ${haystack}`);
    }
  });
});

describe("emptyStateFor() — fallback for unknown kind", () => {
  test("returns a non-crashing default title", () => {
    const c = emptyStateFor("unknown-kind");
    assert.ok(c.title.includes("unknown-kind"));
    assert.equal(c.body, "");
    assert.equal(c.hint, undefined);
  });
});

describe("hasEmptyState()", () => {
  test("true for curated kinds", () => {
    for (const kind of CURATED_KINDS) {
      assert.equal(hasEmptyState(kind), true, kind);
    }
  });

  test("false for unknown", () => {
    assert.equal(hasEmptyState("not-a-real-kind"), false);
  });
});
