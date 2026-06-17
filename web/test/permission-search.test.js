// test/permission-search.test.js — unit tests for the Permissions-tab
// search filter (slice #170.C).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { filterAuthorization } from "../dist/permission-search.js";

const SAMPLE = {
  super_users: ["root", "admin"],
  user_groups: {
    "ops": ["alice", "bob"],
    "spec-team": ["alice", "carol"],
    "routing-team": ["dave"],
  },
  permissions: {
    "spec.author":    ["spec-team"],
    "service.apply":  { groups: ["ops"], users: ["eve"] },
    "service.remove": [
      { groups: ["ops"], where: { resource: "transit-*" } },
      { users: ["frank"] },
    ],
    "vrf.bind":       { allow: ["routing-team"], where: { vrf: "blue" } },
    "vlan.create":    ["ops"],
  },
};

describe("filterAuthorization() — totals", () => {
  test("totals always reflect the unfiltered counts", () => {
    const r = filterAuthorization("vrf", SAMPLE);
    assert.deepEqual(r.totals, { superUsers: 2, userGroups: 3, permissions: 5 });
  });
});

describe("filterAuthorization() — empty query", () => {
  test("passes everything through unchanged", () => {
    const r = filterAuthorization("", SAMPLE);
    assert.deepEqual(r.superUsers, ["root", "admin"]);
    assert.deepEqual(Object.keys(r.userGroups).sort(), ["ops", "routing-team", "spec-team"]);
    assert.deepEqual(r.permissions.sort(), [
      "service.apply", "service.remove", "spec.author", "vlan.create", "vrf.bind",
    ]);
  });

  test("whitespace-only query is treated as empty", () => {
    const r = filterAuthorization("   ", SAMPLE);
    assert.equal(r.permissions.length, 5);
  });
});

describe("filterAuthorization() — super-users", () => {
  test("filters by identity substring", () => {
    const r = filterAuthorization("root", SAMPLE);
    assert.deepEqual(r.superUsers, ["root"]);
  });

  test("case-insensitive", () => {
    const r = filterAuthorization("ROOT", SAMPLE);
    assert.deepEqual(r.superUsers, ["root"]);
  });

  test("no match → empty", () => {
    const r = filterAuthorization("zzzz", SAMPLE);
    assert.deepEqual(r.superUsers, []);
  });
});

describe("filterAuthorization() — user-groups", () => {
  test("filters by group name substring", () => {
    const r = filterAuthorization("ops", SAMPLE);
    assert.ok(Object.keys(r.userGroups).includes("ops"));
  });

  test("matches group when any member matches", () => {
    const r = filterAuthorization("carol", SAMPLE);
    assert.deepEqual(Object.keys(r.userGroups), ["spec-team"]);
  });

  test("returns full member list, not just matching member", () => {
    const r = filterAuthorization("carol", SAMPLE);
    assert.deepEqual(r.userGroups["spec-team"], ["alice", "carol"]);
  });
});

describe("filterAuthorization() — permissions", () => {
  test("matches wire name", () => {
    const r = filterAuthorization("vrf", SAMPLE);
    assert.ok(r.permissions.includes("vrf.bind"));
  });

  test("matches curated title", () => {
    // "Apply service to interface" is the curated title for service.apply
    const r = filterAuthorization("apply service", SAMPLE);
    assert.ok(r.permissions.includes("service.apply"));
  });

  test("matches curated body", () => {
    // "Define a new VLAN on a device" is the curated body for vlan.create
    const r = filterAuthorization("define a new vlan", SAMPLE);
    assert.ok(r.permissions.includes("vlan.create"));
  });

  test("matches grant member (group name)", () => {
    const r = filterAuthorization("spec-team", SAMPLE);
    assert.ok(r.permissions.includes("spec.author"));
  });

  test("matches grant member (direct user)", () => {
    const r = filterAuthorization("frank", SAMPLE);
    assert.ok(r.permissions.includes("service.remove"));
  });

  test("matches grant member referenced via legacy allow field", () => {
    const r = filterAuthorization("routing-team", SAMPLE);
    assert.ok(r.permissions.includes("vrf.bind"));
  });

  test("case-insensitive", () => {
    const r = filterAuthorization("VRF", SAMPLE);
    assert.ok(r.permissions.includes("vrf.bind"));
  });

  test("no match → empty permissions list", () => {
    const r = filterAuthorization("zzzz-nonexistent", SAMPLE);
    assert.deepEqual(r.permissions, []);
  });

  test("query matching nothing also filters super-users + groups (consistent narrowing)", () => {
    const r = filterAuthorization("zzzz-nonexistent", SAMPLE);
    assert.deepEqual(r.superUsers, []);
    assert.deepEqual(r.userGroups, {});
  });
});

describe("filterAuthorization() — cross-section consistency", () => {
  test("'alice' surfaces every section she touches", () => {
    const r = filterAuthorization("alice", SAMPLE);
    // alice is in ops + spec-team (member match)
    assert.deepEqual(Object.keys(r.userGroups).sort(), ["ops", "spec-team"]);
    // alice doesn't directly hold any permission, so the permissions list
    // is empty — grants reference her by group, not by direct user name.
    // (This is honest: the search shows what the data shows, no implicit
    // expansion. The lookup section handles the "what does alice hold?"
    // question via summarizeUser.)
  });
});
