// test/node-references.test.js — unit tests for deriveNodeLinks (delete-flow
// force-cascade detection).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveNodeLinks } from "../dist/node-references.js";

const TOPO = {
  nodes: { switch1: {}, switch2: {}, host1: {} },
  links: [
    { a: "switch1:Ethernet0", z: "switch2:Ethernet0" },
    { a: "host1:eth0", z: "switch1:Ethernet4" },
    { a: "switch2:Ethernet8", z: "host1:eth1" },
  ],
};

describe("deriveNodeLinks", () => {
  test("returns every link touching the node, with the peer device", () => {
    const links = deriveNodeLinks(TOPO, "switch1");
    assert.equal(links.length, 2);
    assert.deepEqual(new Set(links.map((l) => l.peer)), new Set(["switch2", "host1"]));
  });

  test("matches on either endpoint (a or z)", () => {
    // host1 appears as `a` in one link and `z` in another.
    const links = deriveNodeLinks(TOPO, "host1");
    assert.equal(links.length, 2);
    assert.deepEqual(new Set(links.map((l) => l.peer)), new Set(["switch1", "switch2"]));
  });

  test("an unlinked node returns no links (bare delete, no force needed)", () => {
    assert.deepEqual(deriveNodeLinks({ ...TOPO, nodes: { ...TOPO.nodes, lonely: {} } }, "lonely"), []);
  });

  test("does NOT match a device whose name is a prefix of the target", () => {
    const topo = { links: [{ a: "switch10:Ethernet0", z: "switch2:Ethernet0" }] };
    assert.deepEqual(deriveNodeLinks(topo, "switch1"), []);
  });

  test("tolerates missing / malformed topology", () => {
    assert.deepEqual(deriveNodeLinks(null, "x"), []);
    assert.deepEqual(deriveNodeLinks({}, "x"), []);
    assert.deepEqual(deriveNodeLinks({ links: "nope" }, "x"), []);
  });
});

import { availableInterfacesByDevice } from "../dist/node-references.js";

const FAB = {
  nodes: {
    switch1: { ports: { Ethernet0: {}, Ethernet4: {}, Ethernet31: {} } },
    switch2: { ports: { Ethernet0: {}, Ethernet4: {} } },
    host1: {}, // no ports
  },
  links: [
    { a: "switch1:Ethernet0", z: "switch2:Ethernet0" },
    { a: "switch1:Ethernet4", z: "switch2:Ethernet4" },
  ],
};

describe("availableInterfacesByDevice", () => {
  test("returns declared ports that aren't already wired", () => {
    const m = availableInterfacesByDevice(FAB);
    assert.deepEqual(m.get("switch1"), ["Ethernet31"]); // 0 + 4 wired, 31 free
    assert.deepEqual(m.get("switch2"), []);             // both ports wired
    assert.deepEqual(m.get("host1"), []);               // no declared ports
  });

  test("also excludes endpoints wired by pending (extraWired) links", () => {
    const m = availableInterfacesByDevice(FAB, ["switch1:Ethernet31"]);
    assert.deepEqual(m.get("switch1"), []); // 31 now pending-wired
  });

  test("sorts interfaces numerically (Ethernet2 before Ethernet10)", () => {
    const topo = { nodes: { s: { ports: { Ethernet10: {}, Ethernet2: {}, Ethernet1: {} } } }, links: [] };
    assert.deepEqual(availableInterfacesByDevice(topo).get("s"), ["Ethernet1", "Ethernet2", "Ethernet10"]);
  });

  test("tolerates malformed topology", () => {
    assert.equal(availableInterfacesByDevice(null).size, 0);
    assert.equal(availableInterfacesByDevice({}).size, 0);
  });
});
