// port-config.test.js — pure helpers for the schema-driven port-config flow:
// the inventory-driven picker and the whole-device merge.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildPicker, mergePort, prefillForPort } from "../dist/port-config.js";

const inventory = [
  { name: "Ethernet0", nic_index: 1, speed: "40G" },
  { name: "Ethernet4", nic_index: 2, speed: "40G" },
  { name: "Ethernet8", nic_index: 3, speed: "40G" },
];

describe("buildPicker() — inventory is the menu, topology marks the chosen", () => {
  test("lists every inventory port as unconfigured when nothing is set", () => {
    const rows = buildPicker(inventory, undefined, undefined);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.status), ["unconfigured", "unconfigured", "unconfigured"]);
    assert.equal(rows[0].speed, "40G", "inventory speed carried for prefill");
  });

  test("marks committed topology ports configured (and carries their config)", () => {
    const rows = buildPicker(inventory, { Ethernet0: { admin_status: "up", mtu: 9100 } }, undefined);
    const e0 = rows.find((r) => r.name === "Ethernet0");
    assert.equal(e0.status, "configured");
    assert.deepEqual(e0.config, { admin_status: "up", mtu: 9100 });
    assert.equal(rows.find((r) => r.name === "Ethernet4").status, "unconfigured");
  });

  test("pending wins over committed and is marked pending", () => {
    const rows = buildPicker(
      inventory,
      { Ethernet0: { admin_status: "up" } },
      { Ethernet0: { admin_status: "down" } },
    );
    const e0 = rows.find((r) => r.name === "Ethernet0");
    assert.equal(e0.status, "pending");
    assert.deepEqual(e0.config, { admin_status: "down" }, "pending config shown");
  });

  test("only inventory ports appear (topology.Ports ⊆ platform.Ports by construction)", () => {
    const rows = buildPicker(inventory, { Ethernet999: { admin_status: "up" } }, undefined);
    assert.equal(rows.length, 3);
    assert.equal(rows.some((r) => r.name === "Ethernet999"), false);
  });
});

describe("mergePort() — immutable whole-device merge", () => {
  test("sets a port without touching steps or sibling ports", () => {
    const dev = { steps: [{ url: "/setup-device" }], ports: { Ethernet0: { mtu: 9100 } } };
    const next = mergePort(dev, "Ethernet4", { admin_status: "up" });
    assert.deepEqual(next.ports, { Ethernet0: { mtu: 9100 }, Ethernet4: { admin_status: "up" } });
    assert.deepEqual(next.steps, dev.steps, "steps preserved");
    assert.notEqual(next, dev, "returns a new object");
    assert.deepEqual(dev.ports, { Ethernet0: { mtu: 9100 } }, "input not mutated");
  });

  test("overwrites an existing port's config", () => {
    const dev = { ports: { Ethernet0: { mtu: 1500 } } };
    const next = mergePort(dev, "Ethernet0", { mtu: 9100, admin_status: "up" });
    assert.deepEqual(next.ports.Ethernet0, { mtu: 9100, admin_status: "up" });
  });

  test("handles an undefined device (fresh ports map)", () => {
    const next = mergePort(undefined, "Ethernet0", { admin_status: "up" });
    assert.deepEqual(next.ports, { Ethernet0: { admin_status: "up" } });
  });
});

describe("prefillForPort() — edit existing config, else inventory speed", () => {
  test("returns existing config for a configured port (no synthetic port field)", () => {
    const pre = prefillForPort({ name: "Ethernet0", status: "configured", speed: "40G", config: { admin_status: "up", mtu: 9100 } });
    assert.deepEqual(pre, { admin_status: "up", mtu: 9100 });
    assert.equal("port" in pre, false, "port is the map key, never a body field");
  });

  test("seeds speed from inventory for an unconfigured port", () => {
    const pre = prefillForPort({ name: "Ethernet0", status: "unconfigured", speed: "40G" });
    assert.deepEqual(pre, { speed: "40G" });
  });

  test("empty prefill when no config and no inventory speed", () => {
    const pre = prefillForPort({ name: "Ethernet0", status: "unconfigured" });
    assert.deepEqual(pre, {});
  });
});
