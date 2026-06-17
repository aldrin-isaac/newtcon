// test/projection-aggregator.test.js — unit tests for the pure
// projection-aggregator helpers (slice #171.B).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { groupByDevice, summarizeDiff } from "../dist/projection-aggregator.js";

const deviceAction = (id, device, actionId, body = {}) =>
  ({ id, group: "device", op: "action", device, actionId, label: actionId, body });
const ifaceAction = (id, device, iface, actionId, body = {}) =>
  ({ id, group: "interface", op: "action", device, iface, actionId, label: actionId, body });
const specCreate = (id, kind, name) =>
  ({ id, group: "spec", kind, op: "create", name, body: {} });

describe("groupByDevice()", () => {
  test("empty queue → empty list", () => {
    assert.deepEqual(groupByDevice([]), []);
  });

  test("device.action maps to {url: '/<actionId>', params: body}", () => {
    const r = groupByDevice([deviceAction("1", "r1", "create-vlan", { vlan_id: 100 })]);
    assert.equal(r.length, 1);
    assert.equal(r[0].device, "r1");
    assert.equal(r[0].ops.length, 1);
    assert.equal(r[0].ops[0].url, "/create-vlan");
    assert.deepEqual(r[0].ops[0].params, { vlan_id: 100 });
  });

  test("interface.action maps to '/interfaces/<iface>/<actionId>'", () => {
    const r = groupByDevice([ifaceAction("1", "r1", "Ethernet0", "set-mtu", { mtu: 9000 })]);
    assert.equal(r[0].ops[0].url, "/interfaces/Ethernet0/set-mtu");
  });

  test("multiple ops on same device collected into one batch", () => {
    const r = groupByDevice([
      deviceAction("1", "r1", "create-vlan", { vlan_id: 100 }),
      ifaceAction("2", "r1", "Ethernet0", "set-mtu", { mtu: 9000 }),
      deviceAction("3", "r1", "create-vrf", { vrf_name: "blue" }),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].ops.length, 3);
  });

  test("preserves op order within a device (apply order matters)", () => {
    const r = groupByDevice([
      deviceAction("1", "r1", "first"),
      deviceAction("2", "r1", "second"),
      deviceAction("3", "r1", "third"),
    ]);
    assert.deepEqual(r[0].ops.map((o) => o.url), ["/first", "/second", "/third"]);
  });

  test("multiple devices → batches sorted by device name", () => {
    const r = groupByDevice([
      deviceAction("1", "spine2", "a"),
      deviceAction("2", "leaf1", "b"),
      deviceAction("3", "spine1", "c"),
    ]);
    assert.deepEqual(r.map((b) => b.device), ["leaf1", "spine1", "spine2"]);
  });

  test("spec mutations are excluded (handled by a separate slice)", () => {
    const r = groupByDevice([
      specCreate("1", "services", "transit"),
      deviceAction("2", "r1", "create-vlan"),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].device, "r1");
  });

  test("topology mutations are excluded (no device-mapping yet)", () => {
    const r = groupByDevice([
      { id: "1", group: "topology", op: "add-device", name: "r1", body: {} },
      { id: "2", group: "topology", op: "add-link", a: "r1:e0", z: "r2:e0" },
      deviceAction("3", "r2", "x"),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].device, "r2");
  });
});

describe("summarizeDiff()", () => {
  test("undefined → all zero", () => {
    assert.deepEqual(summarizeDiff(undefined),
      { create: 0, modify: 0, delete: 0, total: 0 });
  });

  test("empty array → all zero", () => {
    assert.deepEqual(summarizeDiff([]),
      { create: 0, modify: 0, delete: 0, total: 0 });
  });

  test("counts by change kind", () => {
    const r = summarizeDiff([
      { table: "VLAN", key: "100", change: "create" },
      { table: "VLAN", key: "200", change: "create" },
      { table: "INTERFACE", key: "Ethernet0", change: "modify" },
      { table: "VLAN", key: "300", change: "delete" },
    ]);
    assert.deepEqual(r, { create: 2, modify: 1, delete: 1, total: 4 });
  });

  test("unknown change values are skipped, not counted", () => {
    const r = summarizeDiff([
      { table: "VLAN", key: "100", change: "create" },
      { table: "VLAN", key: "200", change: "unknown" },
      { table: "VLAN", key: "300" },
    ]);
    assert.equal(r.total, 1);
    assert.equal(r.create, 1);
  });
});
