// test/permission-catalog.test.js — unit tests for the curated
// permission-catalog (grouping + descriptions).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  describePermission,
  groupFor,
  groupLabelFor,
  groupPermissions,
  GROUP_ORDER,
} from "../dist/permission-catalog.js";

describe("describePermission()", () => {
  test("returns curated title + body for known permissions", () => {
    const r = describePermission("vrf.bind");
    assert.equal(r.title, "Bind IP VPN to interface");
    assert.ok(r.body.length > 0);
  });
  test("falls back to wire name + empty body for unknown permissions", () => {
    const r = describePermission("future.action");
    assert.equal(r.title, "future.action");
    assert.equal(r.body, "");
  });
});

describe("groupFor()", () => {
  test("routes vrf.* into routing", () => {
    assert.equal(groupFor("vrf.bind"), "routing");
    assert.equal(groupFor("vrf.create"), "routing");
  });
  test("routes service.* into service", () => {
    assert.equal(groupFor("service.apply"), "service");
  });
  test("routes spec.author into spec", () => {
    assert.equal(groupFor("spec.author"), "spec");
  });
  test("routes interface.modify into interface", () => {
    assert.equal(groupFor("interface.modify"), "interface");
  });
  test("routes vlan.* and lag.* into vlan", () => {
    assert.equal(groupFor("vlan.create"), "vlan");
    assert.equal(groupFor("lag.modify"), "vlan");
  });
  test("routes qos.* into qos", () => {
    assert.equal(groupFor("qos.create"), "qos");
  });
  test("routes filter.* and acl.* into filters", () => {
    assert.equal(groupFor("filter.create"), "filters");
    assert.equal(groupFor("acl.modify"), "filters");
  });
  test("routes bgp.*, evpn.* into routing alongside vrf.*", () => {
    assert.equal(groupFor("bgp.peer"), "routing");
    assert.equal(groupFor("evpn.macvpn"), "routing");
  });
  test("routes device.write into device", () => {
    assert.equal(groupFor("device.write"), "device");
  });
  test("unknown lands in other", () => {
    assert.equal(groupFor("future.action"), "other");
  });
});

describe("groupLabelFor()", () => {
  test("returns operator-readable label for every group", () => {
    for (const id of GROUP_ORDER) {
      const label = groupLabelFor(id);
      assert.ok(label && label.length > 0, `group ${id} should have a label`);
    }
  });
});

describe("groupPermissions()", () => {
  test("partitions a live-ish input by group, alphabetised within each group", () => {
    const r = groupPermissions([
      "vrf.bind", "vlan.create", "spec.author", "service.apply",
      "vlan.delete", "service.remove", "vrf.route", "qos.create",
    ]);
    assert.deepEqual(r.get("spec"), ["spec.author"]);
    assert.deepEqual(r.get("service"), ["service.apply", "service.remove"]);
    assert.deepEqual(r.get("vlan"), ["vlan.create", "vlan.delete"]);
    assert.deepEqual(r.get("qos"), ["qos.create"]);
    assert.deepEqual(r.get("routing"), ["vrf.bind", "vrf.route"]);
  });

  test("omits empty groups", () => {
    const r = groupPermissions(["spec.author"]);
    assert.equal(r.has("spec"), true);
    assert.equal(r.has("vlan"), false);
    assert.equal(r.has("other"), false);
  });

  test("preserves GROUP_ORDER for iteration", () => {
    // spec, service, ..., other.
    const r = groupPermissions([
      "future.action", "service.apply", "spec.author", "vrf.bind",
    ]);
    const got = Array.from(r.keys());
    // Expect spec before service before routing before other.
    assert.deepEqual(got, ["spec", "service", "routing", "other"]);
  });

  test("unknown permissions land in 'other'", () => {
    const r = groupPermissions(["mystery.action", "another.unknown"]);
    assert.deepEqual(r.get("other"), ["another.unknown", "mystery.action"]);
  });

  test("empty input → empty map", () => {
    const r = groupPermissions([]);
    assert.equal(r.size, 0);
  });
});
