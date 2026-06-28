// test/empty-states.test.js — unit tests for the curated empty-state
// copy (slice #169.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  emptyStateFor,
  hasEmptyState,
  TOPOLOGY_EMPTY,
  PERMISSIONS_EMPTY,
} from "../dist/empty-states.js";

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

describe("TOPOLOGY_EMPTY (slice #169.B)", () => {
  test("has non-empty title + body", () => {
    assert.ok(TOPOLOGY_EMPTY.title && TOPOLOGY_EMPTY.title.length > 0);
    assert.ok(TOPOLOGY_EMPTY.body && TOPOLOGY_EMPTY.body.length > 0);
  });

  test("body mentions the toolbar's actions (Create node, Deploy)", () => {
    const haystack = TOPOLOGY_EMPTY.body.toLowerCase();
    assert.ok(/create node/.test(haystack), "should mention Create node");
    assert.ok(/deploy|lab/.test(haystack), "should mention Deploy / lab");
  });

  test("hint surfaces the profile prerequisite", () => {
    assert.ok(TOPOLOGY_EMPTY.hint && /profile/i.test(TOPOLOGY_EMPTY.hint));
  });

  test("does not use 'spec' as bare jargon (operator-language lens)", () => {
    // The breadcrumb "Specs → Inventory → Profiles" is fine — that's
    // referring to the visible sidebar tab. A bare standalone "spec"
    // (the internal noun for a YAML/JSON record) is what's banned.
    const haystack = (TOPOLOGY_EMPTY.title + " " + TOPOLOGY_EMPTY.body + " " +
                      (TOPOLOGY_EMPTY.hint ?? "")).toLowerCase();
    assert.ok(!/\bspec\b/.test(haystack),
      "topology empty state should not use 'spec' as bare jargon: " + haystack);
  });
});

describe("PERMISSIONS_EMPTY (slice #169.C)", () => {
  test("has non-empty title + body", () => {
    assert.ok(PERMISSIONS_EMPTY.title && PERMISSIONS_EMPTY.title.length > 0);
    assert.ok(PERMISSIONS_EMPTY.body && PERMISSIONS_EMPTY.body.length > 0);
  });

  test("body names every section the operator will see", () => {
    const haystack = PERMISSIONS_EMPTY.body.toLowerCase();
    assert.ok(/super-users?/.test(haystack), "should mention super-users");
    assert.ok(/user groups?/.test(haystack), "should mention user groups");
    assert.ok(/permissions?/.test(haystack), "should mention permissions");
  });

  test("body explains where the data comes from (newtron network.json + /reload)", () => {
    const haystack = PERMISSIONS_EMPTY.body.toLowerCase();
    assert.ok(/network\.json/.test(haystack), "should reference network.json");
    assert.ok(/reload/.test(haystack), "should reference the /reload upstream verb");
  });

  test("hint is honest about newtcon being read-only here today", () => {
    assert.ok(PERMISSIONS_EMPTY.hint && /read-only/i.test(PERMISSIONS_EMPTY.hint));
  });

  test("uses 'user groups' not 'roles' (vocab discipline)", () => {
    const haystack = (PERMISSIONS_EMPTY.title + " " + PERMISSIONS_EMPTY.body + " " +
                      (PERMISSIONS_EMPTY.hint ?? "")).toLowerCase();
    assert.ok(!/\broles?\b/.test(haystack),
      "Permissions copy must say 'user groups' not 'roles': " + haystack);
  });
});
