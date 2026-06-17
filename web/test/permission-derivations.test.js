// test/permission-derivations.test.js — unit tests for the pure
// derivation layer (forward + inverse member-of views).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGrant,
  summarizeUser,
  summarizePermission,
  allUsers,
} from "../dist/permission-derivations.js";

// A representative authorization payload covering all the wire-shape
// variations the renderer / derivation has to handle.
const SAMPLE = {
  super_users: ["root", "admin"],
  user_groups: {
    "ops": ["alice", "bob"],
    "spec-team": ["alice", "carol"],
    "routing-team": ["dave"],
  },
  permissions: {
    // shorthand list — names get classified against user_groups
    "spec.author": ["spec-team"],
    // typed single object
    "service.apply": { groups: ["ops"], users: ["eve"] },
    // typed list (disjunctive)
    "service.remove": [
      { groups: ["ops"], where: { resource: "transit-*" } },
      { users: ["frank"] },
    ],
    // legacy allow + where
    "vrf.bind": { allow: ["routing-team", "external-auditor"], where: { vrf: "blue" } },
    // shorthand referencing both a group and a direct user
    "vlan.create": ["ops", "grace"],
  },
};

describe("normalizeGrant()", () => {
  test("shorthand list splits into groups vs direct users by membership in user_groups", () => {
    const n = normalizeGrant(["ops", "grace"], SAMPLE.user_groups);
    assert.equal(n.length, 1);
    assert.deepEqual(n[0].groupNames, ["ops"]);
    assert.deepEqual(n[0].userNames, ["grace"]);
    assert.equal(n[0].where, undefined);
  });

  test("typed single object keeps explicit groups/users keys verbatim", () => {
    const n = normalizeGrant({ groups: ["ops"], users: ["eve"] }, SAMPLE.user_groups);
    assert.equal(n.length, 1);
    assert.deepEqual(n[0].groupNames, ["ops"]);
    assert.deepEqual(n[0].userNames, ["eve"]);
  });

  test("typed list returns one normalized grant per element", () => {
    const n = normalizeGrant(SAMPLE.permissions["service.remove"], SAMPLE.user_groups);
    assert.equal(n.length, 2);
    assert.deepEqual(n[0].groupNames, ["ops"]);
    assert.deepEqual(n[0].where, { resource: "transit-*" });
    assert.deepEqual(n[1].userNames, ["frank"]);
    assert.equal(n[1].where, undefined);
  });

  test("legacy allow field classifies each name", () => {
    const n = normalizeGrant(SAMPLE.permissions["vrf.bind"], SAMPLE.user_groups);
    assert.equal(n.length, 1);
    assert.deepEqual(n[0].groupNames, ["routing-team"]);
    assert.deepEqual(n[0].userNames, ["external-auditor"]);
    assert.deepEqual(n[0].where, { vrf: "blue" });
  });

  test("empty where is omitted from the normalized output", () => {
    const n = normalizeGrant({ groups: ["ops"], where: {} }, SAMPLE.user_groups);
    assert.equal(n[0].where, undefined);
  });

  test("unknown shape returns empty array", () => {
    assert.deepEqual(normalizeGrant(null, SAMPLE.user_groups), []);
    assert.deepEqual(normalizeGrant(42, SAMPLE.user_groups), []);
  });
});

describe("summarizeUser()", () => {
  test("super-user holds every permission with source super_user", () => {
    const s = summarizeUser("root", SAMPLE);
    assert.equal(s.isSuperUser, true);
    assert.equal(s.permissions.length, 5);
    for (const p of s.permissions) {
      assert.equal(p.source, "super_user");
    }
  });

  test("regular user lists group memberships alphabetised", () => {
    const s = summarizeUser("alice", SAMPLE);
    assert.equal(s.isSuperUser, false);
    assert.deepEqual(s.groups, ["ops", "spec-team"]);
  });

  test("regular user holds via-group permissions with correct viaGroup source", () => {
    const s = summarizeUser("alice", SAMPLE);
    const specAuthor = s.permissions.find((p) => p.name === "spec.author");
    assert.ok(specAuthor);
    assert.deepEqual(specAuthor.source, { viaGroup: "spec-team" });
    const serviceApply = s.permissions.find((p) => p.name === "service.apply");
    assert.deepEqual(serviceApply.source, { viaGroup: "ops" });
  });

  test("user holds permission directly when listed by name", () => {
    const s = summarizeUser("eve", SAMPLE);
    const sa = s.permissions.find((p) => p.name === "service.apply");
    assert.ok(sa);
    assert.equal(sa.source, "direct");
  });

  test("where-clause is preserved in EffectivePermission", () => {
    const s = summarizeUser("bob", SAMPLE);
    const sr = s.permissions.find((p) => p.name === "service.remove");
    assert.ok(sr);
    assert.deepEqual(sr.where, { resource: "transit-*" });
  });

  test("user not in the table holds nothing", () => {
    const s = summarizeUser("nobody", SAMPLE);
    assert.equal(s.isSuperUser, false);
    assert.deepEqual(s.groups, []);
    assert.deepEqual(s.permissions, []);
  });

  test("user with multiple routes to the same permission gets one entry per route", () => {
    // Construct a case where alice holds X both directly and via group "ops".
    const data = {
      super_users: [],
      user_groups: { "ops": ["alice"] },
      permissions: {
        "weird.perm": [{ users: ["alice"] }, { groups: ["ops"] }],
      },
    };
    const s = summarizeUser("alice", data);
    assert.equal(s.permissions.length, 2);
    const sources = s.permissions.map((p) => p.source);
    assert.ok(sources.includes("direct"));
    assert.ok(sources.some((s) => typeof s === "object" && s.viaGroup === "ops"));
  });
});

describe("summarizePermission()", () => {
  test("super_users are always surfaced separately", () => {
    const s = summarizePermission("spec.author", SAMPLE);
    assert.deepEqual(s.superUsers, ["admin", "root"]);
  });

  test("shorthand-list permission expands its group member references", () => {
    const s = summarizePermission("spec.author", SAMPLE);
    assert.equal(s.grants.length, 1);
    assert.deepEqual(s.grants[0].directUsers, []);
    assert.equal(s.grants[0].groups.length, 1);
    assert.equal(s.grants[0].groups[0].name, "spec-team");
    assert.deepEqual(s.grants[0].groups[0].members, ["alice", "carol"]);
  });

  test("typed-list permission returns one expanded grant per sub-grant", () => {
    const s = summarizePermission("service.remove", SAMPLE);
    assert.equal(s.grants.length, 2);
    assert.deepEqual(s.grants[0].where, { resource: "transit-*" });
    assert.equal(s.grants[0].groups[0].name, "ops");
    assert.deepEqual(s.grants[1].directUsers, ["frank"]);
  });

  test("typed grant with mixed groups + users yields both populated", () => {
    const s = summarizePermission("service.apply", SAMPLE);
    assert.equal(s.grants.length, 1);
    assert.deepEqual(s.grants[0].directUsers, ["eve"]);
    assert.equal(s.grants[0].groups[0].name, "ops");
    assert.deepEqual(s.grants[0].groups[0].members, ["alice", "bob"]);
  });

  test("unknown permission name returns empty grants list (superUsers still listed)", () => {
    const s = summarizePermission("future.perm", SAMPLE);
    assert.deepEqual(s.grants, []);
    assert.deepEqual(s.superUsers, ["admin", "root"]);
  });
});

describe("allUsers()", () => {
  test("collects super_users + group members + direct grant users, de-duped + sorted", () => {
    const u = allUsers(SAMPLE);
    assert.deepEqual(u, [
      "admin", "alice", "bob", "carol", "dave",
      "eve", "external-auditor", "frank", "grace", "root",
    ]);
  });

  test("empty payload yields empty list", () => {
    const u = allUsers({ super_users: [], user_groups: {}, permissions: {} });
    assert.deepEqual(u, []);
  });
});
