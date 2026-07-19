// topology-focus.test.js + fabric-health assertions (uplift 4.5).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { neighborsOf, focusDim, nearestInDirection } from "../dist/topology-focus.js";
import { aggregateFabricHealth } from "../dist/fabric-health.js";

const LINKS = [
  { local_device: "switch1", local_interface: "Ethernet0", remote_device: "switch2", remote_interface: "Ethernet0" },
  { local_device: "switch2", local_interface: "Ethernet4", remote_device: "switch3", remote_interface: "Ethernet4" },
  { local_device: "switch1", local_interface: "Ethernet1", remote_device: "host1", remote_interface: "eth0" },
];
const ALL = ["switch1", "switch2", "switch3", "host1", "host2"];

describe("neighborsOf() / focusDim()", () => {
  test("direct neighbors from either link direction", () => {
    assert.deepEqual([...neighborsOf("switch2", LINKS)].sort(), ["switch1", "switch3"]);
    assert.deepEqual([...neighborsOf("host1", LINKS)], ["switch1"]);
  });

  test("focusDim keeps the device + neighbors, dims the rest", () => {
    assert.deepEqual([...focusDim("switch1", ALL, LINKS)].sort(), ["host2", "switch3"]);
  });

  test("isolated device dims everyone else", () => {
    assert.deepEqual([...focusDim("host2", ALL, LINKS)].sort(), ["host1", "switch1", "switch2", "switch3"]);
  });
});

describe("nearestInDirection()", () => {
  const POS = new Map([
    ["a", { cx: 0, cy: 0 }],
    ["b", { cx: 100, cy: 0 }],
    ["c", { cx: 200, cy: 0 }],
    ["d", { cx: 0, cy: 100 }],
    ["e", { cx: 90, cy: 200 }],
  ]);
  test("nearest along the axis wins", () => {
    assert.equal(nearestInDirection("a", POS, "right"), "b");
    assert.equal(nearestInDirection("b", POS, "right"), "c");
    assert.equal(nearestInDirection("c", POS, "left"), "b");
    assert.equal(nearestInDirection("a", POS, "down"), "d");
  });
  test("cone excludes mostly-sideways candidates", () => {
    assert.equal(nearestInDirection("d", POS, "down"), "e", "within the 90° cone");
    assert.equal(nearestInDirection("a", POS, "up"), null, "nothing above");
  });
  test("unknown origin → null", () => {
    assert.equal(nearestInDirection("zz", POS, "left"), null);
  });
});

describe("aggregateFabricHealth()", () => {
  test("down sessions dominate the underlay cell", () => {
    const s = aggregateFabricHealth({
      underlayByDevice: new Map([["s1", "down"], ["s2", "ok"]]),
      driftByDevice: new Map(),
      labNodeStatus: new Map(),
    });
    assert.equal(s.underlay.label, "underlay: 1 down");
    assert.equal(s.underlay.tone, "danger");
    assert.equal(s.drift.label, "drift: —");
    assert.equal(s.lab.tone, "muted");
  });

  test("healthy fleet reads calm", () => {
    const s = aggregateFabricHealth({
      underlayByDevice: new Map([["s1", "ok"], ["s2", "ok"]]),
      driftByDevice: new Map([["s1", 0], ["s2", 0]]),
      labNodeStatus: new Map([["s1", "running"], ["s2", "running"]]),
    });
    assert.deepEqual(s.underlay, { label: "underlay: converged", tone: "ok" });
    assert.deepEqual(s.drift, { label: "drift: clean", tone: "ok" });
    assert.deepEqual(s.lab, { label: "lab: 2/2 up", tone: "ok" });
  });

  test("partial lab is a warning; drifted devices counted", () => {
    const s = aggregateFabricHealth({
      underlayByDevice: new Map(),
      driftByDevice: new Map([["s1", 3], ["s2", 0]]),
      labNodeStatus: new Map([["s1", "running"], ["s2", "stopped"]]),
    });
    assert.deepEqual(s.drift, { label: "drift: 1 device", tone: "warn" });
    assert.deepEqual(s.lab, { label: "lab: 1/2 up", tone: "warn" });
  });
});
