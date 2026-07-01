// port-config.test.js — pure helpers for the schema-driven port-config flow:
// numeric port ordering and the whole-device merge.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mergePort, comparePorts } from "../dist/port-config.js";

describe("comparePorts() — numeric, not lexicographic", () => {
  test("orders Ethernet ports low→high by trailing number", () => {
    const got = ["Ethernet100", "Ethernet0", "Ethernet12", "Ethernet4", "Ethernet124", "Ethernet8"].sort(comparePorts);
    assert.deepEqual(got, ["Ethernet0", "Ethernet4", "Ethernet8", "Ethernet12", "Ethernet100", "Ethernet124"]);
  });

  test("handles multi-number names (ge-0/0/0 < ge-0/0/10)", () => {
    const got = ["ge-0/0/10", "ge-0/0/2", "ge-0/0/0", "ge-0/0/1"].sort(comparePorts);
    assert.deepEqual(got, ["ge-0/0/0", "ge-0/0/1", "ge-0/0/2", "ge-0/0/10"]);
  });

  test("falls back to lexicographic for non-numeric tails", () => {
    const got = ["Loopback0", "Ethernet0", "Vlan10"].sort(comparePorts);
    assert.deepEqual(got, ["Ethernet0", "Loopback0", "Vlan10"]);
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
